//! CreditGate — minimal demo consumer of the confidential margin layer.
//!
//! HACKATHON PROTOTYPE. This is NOT a lending market: no liquidity curves, no
//! interest-rate markets, no lender deposits beyond a test treasury, no
//! liquidation auctions. Its job:
//!
//!   receive K-of-N risk-engine attestations (Ed25519, verified via the
//!     native program + instructions sysvar)
//!     → check they bind to the vault's current collateral state
//!     → release test-USDC, publish margin status, or EXECUTE LIQUIDATION
//!     → freeze withdrawals at the vault while credit is outstanding
//!
//! Transparency: every consumed attestation is logged on-chain as an event
//! (decision, amount, nonce, approver bitmap) so anyone can audit the risk
//! engines' behavior over time.
//!
//! Trust model (honest): K-of-N attesters is QUORUM, not trustlessness. A
//! production system replaces the committee with MPC (Arcium) or ZK proofs.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{ed25519_program, sysvar::instructions as ix_sysvar};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use confidential_vault::{RiskPolicy, Vault};

declare_id!("6uLcY78dvjTYhwLzZUmridf5zUiEmmDHpLhidHezao3S");

/// Versioned magic prefix of the signed attestation message (v2 adds the
/// liquidation target: seize_mint + seize_amount).
const ATTESTATION_MAGIC: &[u8; 4] = b"CML2";

/// v2 gate seed: the v1 gate PDA (pre-quorum layout) stays on devnet as
/// history; this gate is a fresh PDA.
const GATE_V2_SEED: &[u8] = b"gate-v2";

pub const DECISION_ELIGIBLE: u8 = 0;
pub const DECISION_INELIGIBLE: u8 = 1;
pub const DECISION_MARGIN_CALL: u8 = 2;
pub const DECISION_LIQUIDATE: u8 = 3;

pub const STATUS_COMPLIANT: u8 = 0;
pub const STATUS_MARGIN_CALL: u8 = 1;
pub const STATUS_INELIGIBLE: u8 = 2;
pub const STATUS_REPAID: u8 = 3;
pub const STATUS_LIQUIDATED: u8 = 4;

/// The exact byte message the risk engines sign. Built on-chain from the
/// attestation struct so client and program cannot diverge.
/// Layout: magic(4) | vault(32) | commitment(32) | policy_id(8) |
///         requested_amount_usdc(u64) | decision(u8) | valid_until(i64) |
///         nonce(u64) [| seize_mint(32) | seize_amount(u64) for LIQUIDATE]
#[inline(never)]
fn build_attestation_message(vault: &Pubkey, a: &AttestationData) -> Vec<u8> {
    let mut m = Vec::with_capacity(4 + 32 + 32 + 8 + 8 + 1 + 8 + 8);
    m.extend_from_slice(ATTESTATION_MAGIC);
    m.extend_from_slice(vault.as_ref());
    m.extend_from_slice(&a.commitment);
    m.extend_from_slice(&a.policy_id);
    m.extend_from_slice(&a.requested_amount_usdc.to_le_bytes());
    m.push(a.decision);
    m.extend_from_slice(&a.valid_until.to_le_bytes());
    m.extend_from_slice(&a.nonce.to_le_bytes());
    if a.decision == DECISION_LIQUIDATE {
        m.extend_from_slice(a.seize_mint.as_ref());
        m.extend_from_slice(&a.seize_amount.to_le_bytes());
    }
    m
}

/// Scan the instructions sysvar for Ed25519Program instructions signed by
/// members of `attesters` over exactly `expected_msg`, and return a bitmap of
/// which attesters approved. The native Ed25519 program has already validated
/// each signature (invalid ones fail the whole transaction); here we pin the
/// verified signatures to known attesters and our exact message.
#[inline(never)]
fn collect_approvals(
    ix_sysvar_info: &AccountInfo,
    attesters: &[Pubkey; 3],
    expected_msg: &[u8],
) -> Result<u8> {
    let mut mask = 0u8;
    // Instructions are contiguous: the first out-of-range index ends the scan.
    for i in 0..64usize {
        let ix = match ix_sysvar::load_instruction_at_checked(i, ix_sysvar_info) {
            Ok(ix) => ix,
            Err(_) => break,
        };
        if ix.program_id != ed25519_program::id() {
            continue;
        }
        if let Some((pk_bytes, msg)) = parse_ed25519_instruction(&ix.data) {
            // Members after the first may sign the SHA-256 digest of the
            // message instead of the full message (keeps transactions small);
            // a signature over the digest is equally binding.
            let matches = msg == expected_msg
                || msg == anchor_lang::solana_program::hash::hash(expected_msg).as_ref();
            if !matches {
                continue;
            }
            if let Some(pos) = attesters.iter().position(|a| a.as_ref() == pk_bytes) {
                mask |= 1 << pos;
            }
        }
    }
    Ok(mask)
}

/// Extract (pubkey, message) from an Ed25519Program instruction, rejecting
/// anything that reads from external instructions or accounts.
#[inline(never)]
fn parse_ed25519_instruction(data: &[u8]) -> Option<(&[u8], &[u8])> {
    if data.len() < 16 || data[0] != 1 {
        return None;
    }
    let le16 = |b: &[u8]| u16::from_le_bytes([b[0], b[1]]);
    let sig_off = le16(&data[2..4]) as usize;
    let sig_ix = le16(&data[4..6]);
    let pk_off = le16(&data[6..8]) as usize;
    let pk_ix = le16(&data[8..10]);
    let msg_off = le16(&data[10..12]) as usize;
    let msg_len = le16(&data[12..14]) as usize;
    let msg_ix = le16(&data[14..16]);

    // 0xFFFF = "read from this instruction's own data".
    if sig_ix != u16::MAX || pk_ix != u16::MAX || msg_ix != u16::MAX {
        return None;
    }
    if sig_off.saturating_add(64) > data.len()
        || pk_off.saturating_add(32) > data.len()
        || msg_off.saturating_add(msg_len) > data.len()
    {
        return None;
    }
    let _ = sig_off; // signature bytes themselves are validated by the native program
    Some((&data[pk_off..pk_off + 32], &data[msg_off..msg_off + msg_len]))
}

#[program]
pub mod credit_gate {
    use super::*;

    /// Spin up the demo gate: pin the risk-engine attester committee (K-of-N)
    /// and the test-USDC mint, and create the treasury that funds credit.
    pub fn initialize_gate(
        ctx: Context<InitializeGate>,
        attesters: [Pubkey; 3],
        attesters_required: u8,
    ) -> Result<()> {
        require!(
            attesters_required >= 1 && attesters_required <= 3,
            CreditGateError::InvalidQuorum
        );
        for a in attesters.iter() {
            require!(*a != Pubkey::default(), CreditGateError::InvalidQuorum);
        }
        let gate = &mut ctx.accounts.gate;
        gate.authority = ctx.accounts.authority.key();
        gate.attesters = attesters;
        gate.attesters_required = attesters_required;
        gate.usdc_mint = ctx.accounts.usdc_mint.key();
        gate.bump = ctx.bumps.gate;
        gate.total_released_usdc = 0;
        emit!(GateInitialized {
            gate: gate.key(),
            attesters,
            attesters_required,
        });
        Ok(())
    }

    /// Gate authority may rotate the attester committee.
    pub fn set_attesters(
        ctx: Context<SetAttester>,
        attesters: [Pubkey; 3],
        attesters_required: u8,
    ) -> Result<()> {
        require!(
            attesters_required >= 1 && attesters_required <= 3,
            CreditGateError::InvalidQuorum
        );
        for a in attesters.iter() {
            require!(*a != Pubkey::default(), CreditGateError::InvalidQuorum);
        }
        let gate = &mut ctx.accounts.gate;
        gate.attesters = attesters;
        gate.attesters_required = attesters_required;
        emit!(AttesterCommitteeRotated {
            attesters,
            attesters_required,
        });
        Ok(())
    }

    /// Seed the demo treasury. This stands in for lender liquidity and is NOT
    /// a lending market: no yield, no shares, no accounting beyond a balance.
    pub fn fund_treasury(ctx: Context<FundTreasury>, amount: u64) -> Result<()> {
        require!(amount > 0, CreditGateError::ZeroAmount);
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.funder_usdc.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;
        emit!(TreasuryFunded { amount });
        Ok(())
    }

    /// The core consumer flow: verify K-of-N attestations and, if they state
    /// ELIGIBLE for this vault's current commitment, release credit AND freeze
    /// vault withdrawals while the debt is outstanding.
    pub fn request_credit(ctx: Context<RequestCredit>, attestation: AttestationData) -> Result<()> {
        let gate = &ctx.accounts.gate;
        let vault = &ctx.accounts.vault;
        let policy = &ctx.accounts.policy;
        let clock = Clock::get()?;

        // 1. The attestation must be signed by enough DISTINCT committee
        //    members over exactly this decision, bound to THIS vault.
        let msg = build_attestation_message(&vault.key(), &attestation);
        let approvals = collect_approvals(
            &ctx.accounts.instruction_sysvar.to_account_info(),
            &gate.attesters,
            &msg,
        )?;
        let approvals_count = approvals.count_ones();
        require!(
            approvals_count >= u32::from(gate.attesters_required),
            CreditGateError::QuorumNotMet
        );

        // 2. Semantic checks.
        require!(
            attestation.decision == DECISION_ELIGIBLE,
            CreditGateError::NotEligibleForCredit
        );
        require!(vault.collateral_locked, CreditGateError::VaultNotLocked);
        require!(
            attestation.commitment == vault.commitment,
            CreditGateError::CommitmentMismatch
        );
        require!(
            attestation.policy_id == policy.policy_id,
            CreditGateError::PolicyMismatch
        );
        require!(attestation.requested_amount_usdc > 0, CreditGateError::ZeroAmount);
        require!(
            clock.unix_timestamp < attestation.valid_until,
            CreditGateError::StaleAttestation
        );

        // 3. Replay protection: attestation nonce is the vault's
        //    portfolio-state version; it must be fresh and unused.
        require!(
            attestation.nonce == vault.commitment_nonce,
            CreditGateError::NonceMismatch
        );
        let facility = &mut ctx.accounts.facility;
        if facility.opened_slot == 0 {
            facility.gate = gate.key();
            facility.vault = vault.key();
            facility.institution = ctx.accounts.institution.key();
        }
        require!(
            attestation.nonce > facility.last_credit_nonce,
            CreditGateError::NonceNotIncreasing
        );

        // 4. Release credit from the test treasury. The gate PDA signs.
        let amount = attestation.requested_amount_usdc;
        let gate_seeds: &[&[u8]] = &[b"gate", GATE_V2_SEED, &[gate.bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.treasury.to_account_info(),
                    to: ctx.accounts.institution_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    authority: ctx.accounts.gate.to_account_info(),
                },
                &[gate_seeds],
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        // 5. Freeze vault withdrawals while this credit is outstanding.
        confidential_vault::cpi::set_withdrawal_gate(
            CpiContext::new_with_signer(
                ctx.accounts.vault_program.to_account_info(),
                confidential_vault::cpi::accounts::VaultCreditAuth {
                    gate_authority: ctx.accounts.gate.to_account_info(),
                    vault: vault.to_account_info(),
                },
                &[gate_seeds],
            ),
            true,
        )?;

        // 6. Record facility + aggregate state (all public, none private).
        facility.outstanding_usdc = facility.outstanding_usdc.saturating_add(amount);
        facility.margin_status = STATUS_COMPLIANT;
        facility.last_credit_nonce = attestation.nonce;
        if facility.opened_slot == 0 {
            facility.opened_slot = clock.slot;
        }
        let gate = &mut ctx.accounts.gate;
        gate.total_released_usdc = gate.total_released_usdc.saturating_add(amount);

        emit!(AttestationLogged {
            vault: vault.key(),
            decision: attestation.decision,
            requested_amount_usdc: amount,
            nonce: attestation.nonce,
            approvals,
        });
        emit!(CreditReleased {
            vault: vault.key(),
            institution: ctx.accounts.institution.key(),
            amount_usdc: amount,
        });
        Ok(())
    }

    /// Publish a margin-status change (MARGIN_CALL / INELIGIBLE / back to
    /// COMPLIANT). Permissionless: the attestation itself is the authority.
    /// The public learns only the status, never the cause in portfolio terms.
    pub fn report_margin_status(
        ctx: Context<ReportMarginStatus>,
        attestation: AttestationData,
    ) -> Result<()> {
        let gate = &ctx.accounts.gate;
        let vault = &ctx.accounts.vault;
        let policy = &ctx.accounts.policy;
        let clock = Clock::get()?;

        let msg = build_attestation_message(&vault.key(), &attestation);
        let approvals = collect_approvals(
            &ctx.accounts.instruction_sysvar.to_account_info(),
            &gate.attesters,
            &msg,
        )?;
        require!(
            approvals.count_ones() >= u32::from(gate.attesters_required),
            CreditGateError::QuorumNotMet
        );

        require!(vault.collateral_locked, CreditGateError::VaultNotLocked);
        require!(
            attestation.commitment == vault.commitment,
            CreditGateError::CommitmentMismatch
        );
        require!(
            attestation.policy_id == policy.policy_id,
            CreditGateError::PolicyMismatch
        );
        require!(
            clock.unix_timestamp < attestation.valid_until,
            CreditGateError::StaleAttestation
        );

        let facility = &mut ctx.accounts.facility;
        if facility.opened_slot == 0 {
            facility.gate = gate.key();
            facility.vault = vault.key();
            facility.institution = vault.institution;
        }
        require!(
            attestation.nonce == vault.commitment_nonce,
            CreditGateError::NonceMismatch
        );
        require!(
            attestation.nonce >= facility.last_status_nonce,
            CreditGateError::NonceNotIncreasing
        );

        facility.last_status_nonce = attestation.nonce;
        facility.margin_status = match attestation.decision {
            DECISION_ELIGIBLE => STATUS_COMPLIANT,
            DECISION_MARGIN_CALL => STATUS_MARGIN_CALL,
            DECISION_INELIGIBLE => STATUS_INELIGIBLE,
            _ => return Err(error!(CreditGateError::InvalidDecision)),
        };

        emit!(AttestationLogged {
            vault: vault.key(),
            decision: attestation.decision,
            requested_amount_usdc: attestation.requested_amount_usdc,
            nonce: attestation.nonce,
            approvals,
        });
        emit!(MarginStatusChanged {
            vault: vault.key(),
            status: facility.margin_status,
        });
        Ok(())
    }

    /// ENFORCEMENT: on a LIQUIDATE attestation (only possible when the
    /// facility is already publicly INELIGIBLE), seize the designated
    /// collateral from vault custody and hand it to the lender receiver.
    /// The debt is extinguished; withdrawals unlock.
    pub fn execute_liquidation(
        ctx: Context<ExecuteLiquidation>,
        attestation: AttestationData,
    ) -> Result<()> {
        let gate = &ctx.accounts.gate;
        let vault = &ctx.accounts.vault;
        let policy = &ctx.accounts.policy;
        let facility = &mut ctx.accounts.facility;
        let clock = Clock::get()?;

        require!(
            attestation.decision == DECISION_LIQUIDATE,
            CreditGateError::NotLiquidationAttestation
        );
        require!(
            facility.margin_status == STATUS_INELIGIBLE,
            CreditGateError::LiquidationNotArmed
        );
        require!(vault.collateral_locked, CreditGateError::VaultNotLocked);
        require!(
            attestation.commitment == vault.commitment,
            CreditGateError::CommitmentMismatch
        );
        require!(
            attestation.policy_id == policy.policy_id,
            CreditGateError::PolicyMismatch
        );
        require!(
            attestation.seize_amount > 0,
            CreditGateError::ZeroAmount
        );
        require!(
            clock.unix_timestamp < attestation.valid_until,
            CreditGateError::StaleAttestation
        );
        require!(
            attestation.nonce == vault.commitment_nonce,
            CreditGateError::NonceMismatch
        );
        require!(
            attestation.nonce >= facility.last_status_nonce,
            CreditGateError::NonceNotIncreasing
        );

        let msg = build_attestation_message(&vault.key(), &attestation);
        let approvals = collect_approvals(
            &ctx.accounts.instruction_sysvar.to_account_info(),
            &gate.attesters,
            &msg,
        )?;
        require!(
            approvals.count_ones() >= u32::from(gate.attesters_required),
            CreditGateError::QuorumNotMet
        );

        let gate_seeds: &[&[u8]] = &[b"gate", GATE_V2_SEED, &[gate.bump]];
        let amount = attestation.seize_amount;
        confidential_vault::cpi::liquidate_custody(
            CpiContext::new_with_signer(
                ctx.accounts.vault_program.to_account_info(),
                confidential_vault::cpi::accounts::LiquidateCustody {
                    gate_authority: ctx.accounts.gate.to_account_info(),
                    vault: vault.to_account_info(),
                    mint: ctx.accounts.seize_mint.to_account_info(),
                    custody: ctx.accounts.seize_custody.to_account_info(),
                    receiver: ctx.accounts.liquidation_receiver.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                &[gate_seeds],
            ),
            amount,
        )?;

        facility.last_status_nonce = attestation.nonce;
        // The attestation's requested_amount_usdc carries the USDC debt offset
        // for this seizure (the risk engine values the seized asset). Multiple
        // seizures across different custody assets are supported: each seizes
        // one asset and offsets part of the debt until outstanding reaches 0.
        let debt_offset = attestation.requested_amount_usdc;
        facility.outstanding_usdc = facility.outstanding_usdc.saturating_sub(debt_offset);
        facility.last_nonce_liquidated = attestation.nonce;

        // Debt fully covered: mark liquidated and unfreeze withdrawals.
        // Otherwise the facility stays INELIGIBLE for further seizures.
        if facility.outstanding_usdc == 0 {
            facility.margin_status = STATUS_LIQUIDATED;
            let gate_seeds: &[&[u8]] = &[b"gate", GATE_V2_SEED, &[gate.bump]];
            confidential_vault::cpi::set_withdrawal_gate(
                CpiContext::new_with_signer(
                    ctx.accounts.vault_program.to_account_info(),
                    confidential_vault::cpi::accounts::VaultCreditAuth {
                        gate_authority: ctx.accounts.gate.to_account_info(),
                        vault: vault.to_account_info(),
                    },
                    &[gate_seeds],
                ),
                false,
            )?;
        } else {
            facility.margin_status = STATUS_INELIGIBLE;
        }

        emit!(AttestationLogged {
            vault: vault.key(),
            decision: attestation.decision,
            requested_amount_usdc: facility.outstanding_usdc,
            nonce: attestation.nonce,
            approvals,
        });
        emit!(LiquidationExecuted {
            vault: vault.key(),
            mint: ctx.accounts.seize_mint.key(),
            units_seized: amount,
            debt_offset_usdc: debt_offset,
            outstanding_after_usdc: facility.outstanding_usdc,
        });
        Ok(())
    }

    /// Repay test-USDC into the treasury. Prototype repayment: no interest,
    /// no penalties. When outstanding reaches zero, withdrawals unlock.
    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        require!(amount > 0, CreditGateError::ZeroAmount);
        let facility = &mut ctx.accounts.facility;
        require!(
            amount <= facility.outstanding_usdc,
            CreditGateError::RepayExceedsOutstanding
        );

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.institution_usdc.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    authority: ctx.accounts.institution.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        facility.outstanding_usdc -= amount;
        if facility.outstanding_usdc == 0 {
            facility.margin_status = STATUS_REPAID;
            // Debt extinguished: unfreeze vault withdrawals.
            let gate = &ctx.accounts.gate;
            let gate_seeds: &[&[u8]] = &[b"gate", GATE_V2_SEED, &[gate.bump]];
            confidential_vault::cpi::set_withdrawal_gate(
                CpiContext::new_with_signer(
                    ctx.accounts.vault_program.to_account_info(),
                    confidential_vault::cpi::accounts::VaultCreditAuth {
                        gate_authority: ctx.accounts.gate.to_account_info(),
                        vault: ctx.accounts.vault.to_account_info(),
                    },
                    &[gate_seeds],
                ),
                false,
            )?;
        }
        emit!(LoanRepaid {
            vault: ctx.accounts.vault.key(),
            remaining_usdc: facility.outstanding_usdc,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// The margin decision. Contains NO private portfolio data by construction:
/// everything here is already public by design (amount, policy, decision).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AttestationData {
    /// sha256 commitment; must equal the vault's current commitment.
    pub commitment: [u8; 32],
    pub policy_id: [u8; 8],
    /// Test-USDC micro-units (6 decimals). HF denominator for status
    /// reports; the release amount for credit requests.
    pub requested_amount_usdc: u64,
    /// DECISION_ELIGIBLE / INELIGIBLE / MARGIN_CALL / LIQUIDATE.
    pub decision: u8,
    /// Unix seconds after which the attestation is void.
    pub valid_until: i64,
    /// Must equal the vault's current commitment_nonce (freshness + replay).
    pub nonce: u64,
    /// Liquidation target: which custody asset to seize and how much.
    pub seize_mint: Pubkey,
    pub seize_amount: u64,
}

#[account]
#[derive(InitSpace)]
pub struct CreditGate {
    pub authority: Pubkey,
    /// Ed25519 keys of the risk-engine committee (prototype: 3 seats).
    pub attesters: [Pubkey; 3],
    /// Distinct committee approvals required per attestation (1..=3).
    pub attesters_required: u8,
    pub usdc_mint: Pubkey,
    pub bump: u8,
    pub total_released_usdc: u64,
}

#[account]
#[derive(InitSpace)]
pub struct CreditFacility {
    pub gate: Pubkey,
    pub vault: Pubkey,
    pub institution: Pubkey,
    pub outstanding_usdc: u64,
    pub margin_status: u8,
    pub last_credit_nonce: u64,
    pub last_status_nonce: u64,
    pub last_nonce_liquidated: u64,
    pub opened_slot: u64,
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeGate<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + CreditGate::INIT_SPACE, seeds = [b"gate", GATE_V2_SEED], bump)]
    pub gate: Account<'info, CreditGate>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = gate,
        associated_token::token_program = token_program,
    )]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAttester<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"gate", GATE_V2_SEED], bump, has_one = authority)]
    pub gate: Account<'info, CreditGate>,
}

#[derive(Accounts)]
pub struct FundTreasury<'info> {
    pub funder: Signer<'info>,
    #[account(seeds = [b"gate", GATE_V2_SEED], bump)]
    pub gate: Account<'info, CreditGate>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = funder,
        associated_token::token_program = token_program,
    )]
    pub funder_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = gate,
        associated_token::token_program = token_program,
    )]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Transaction must contain enough Ed25519Program instructions (immediately
/// before this one) carrying committee signatures over the attestation message.
#[derive(Accounts)]
pub struct RequestCredit<'info> {
    #[account(mut)]
    pub institution: Signer<'info>,
    #[account(mut, seeds = [b"gate", GATE_V2_SEED], bump)]
    pub gate: Box<Account<'info, CreditGate>>,
    #[account(
        mut,
        seeds = [b"vault", vault.institution.as_ref(), b"v2"],
        seeds::program = confidential_vault::ID,
        bump,
        constraint = vault.institution == institution.key()
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(address = vault.policy)]
    pub policy: Box<Account<'info, RiskPolicy>>,
    #[account(
        init_if_needed,
        payer = institution,
        space = 8 + CreditFacility::INIT_SPACE,
        seeds = [b"facility", gate.key().as_ref(), vault.key().as_ref()],
        bump
    )]
    pub facility: Box<Account<'info, CreditFacility>>,
    #[account(address = gate.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = institution,
        associated_token::mint = usdc_mint,
        associated_token::authority = institution,
        associated_token::token_program = token_program,
    )]
    pub institution_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = gate,
        associated_token::token_program = token_program,
    )]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: fixed address, enforced below.
    #[account(
        constraint = instruction_sysvar.key() == anchor_lang::solana_program::sysvar::instructions::id()
    )]
    pub instruction_sysvar: UncheckedAccount<'info>,
    /// CHECK: confidential_vault program, verified by address in the CPI.
    pub vault_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ReportMarginStatus<'info> {
    /// Anyone may submit; the attestation signature is the authority.
    #[account(mut)]
    pub submitter: Signer<'info>,
    #[account(seeds = [b"gate", GATE_V2_SEED], bump)]
    pub gate: Account<'info, CreditGate>,
    #[account(seeds = [b"vault", vault.institution.as_ref(), b"v2"], seeds::program = confidential_vault::ID, bump)]
    pub vault: Account<'info, Vault>,
    #[account(address = vault.policy)]
    pub policy: Account<'info, RiskPolicy>,
    #[account(
        init_if_needed,
        payer = submitter,
        space = 8 + CreditFacility::INIT_SPACE,
        seeds = [b"facility", gate.key().as_ref(), vault.key().as_ref()],
        bump
    )]
    pub facility: Account<'info, CreditFacility>,
    /// CHECK: fixed address, enforced below.
    #[account(
        constraint = instruction_sysvar.key() == anchor_lang::solana_program::sysvar::instructions::id()
    )]
    pub instruction_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteLiquidation<'info> {
    #[account(mut)]
    pub submitter: Signer<'info>,
    #[account(seeds = [b"gate", GATE_V2_SEED], bump)]
    pub gate: Account<'info, CreditGate>,
    #[account(mut, seeds = [b"vault", vault.institution.as_ref(), b"v2"], seeds::program = confidential_vault::ID, bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(address = vault.policy)]
    pub policy: Box<Account<'info, RiskPolicy>>,
    #[account(
        mut,
        seeds = [b"facility", gate.key().as_ref(), vault.key().as_ref()],
        bump,
        constraint = facility.vault == vault.key()
    )]
    pub facility: Box<Account<'info, CreditFacility>>,
    /// The custody asset to seize (designated in the attestation).
    pub seize_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = seize_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub seize_custody: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: liquidation receiver (lender side). The gate PDA authorizes
    /// this exact transfer by signing the vault CPI.
    #[account(mut)]
    pub liquidation_receiver: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: confidential_vault program, verified by address in the CPI.
    pub vault_program: UncheckedAccount<'info>,
    /// CHECK: fixed address, enforced below.
    #[account(
        constraint = instruction_sysvar.key() == anchor_lang::solana_program::sysvar::instructions::id()
    )]
    pub instruction_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Repay<'info> {
    #[account(mut)]
    pub institution: Signer<'info>,
    #[account(seeds = [b"gate", GATE_V2_SEED], bump)]
    pub gate: Account<'info, CreditGate>,
    #[account(
        mut,
        seeds = [b"vault", vault.institution.as_ref(), b"v2"],
        seeds::program = confidential_vault::ID,
        bump,
        constraint = vault.institution == institution.key()
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        mut,
        seeds = [b"facility", gate.key().as_ref(), vault.key().as_ref()],
        bump
    )]
    pub facility: Box<Account<'info, CreditFacility>>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = institution,
        associated_token::token_program = token_program,
    )]
    pub institution_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = gate,
        associated_token::token_program = token_program,
    )]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: confidential_vault program, verified by address in the CPI.
    pub vault_program: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------

#[event]
pub struct GateInitialized {
    pub gate: Pubkey,
    pub attesters: [Pubkey; 3],
    pub attesters_required: u8,
}

#[event]
pub struct AttesterCommitteeRotated {
    pub attesters: [Pubkey; 3],
    pub attesters_required: u8,
}

#[event]
pub struct TreasuryFunded {
    pub amount: u64,
}

/// Transparency log: every consumed attestation, publicly auditable.
#[event]
pub struct AttestationLogged {
    pub vault: Pubkey,
    pub decision: u8,
    pub requested_amount_usdc: u64,
    pub nonce: u64,
    /// Bit i set = attesters[i] signed this attestation.
    pub approvals: u8,
}

/// Public: amount + vault only. Portfolio stays confidential.
#[event]
pub struct CreditReleased {
    pub vault: Pubkey,
    pub institution: Pubkey,
    pub amount_usdc: u64,
}

/// Public: "additional collateral required" style signal, no cause detail.
#[event]
pub struct MarginStatusChanged {
    pub vault: Pubkey,
    pub status: u8,
}

#[event]
pub struct LiquidationExecuted {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub units_seized: u64,
    pub debt_offset_usdc: u64,
    pub outstanding_after_usdc: u64,
}

#[event]
pub struct LoanRepaid {
    pub vault: Pubkey,
    pub remaining_usdc: u64,
}

#[error_code]
pub enum CreditGateError {
    #[msg("no valid Ed25519 attestation instruction found in the transaction")]
    MissingEd25519Instruction,
    #[msg("malformed Ed25519 instruction data")]
    MalformedEd25519Instruction,
    #[msg("unsupported Ed25519 instruction layout (multi-signature or external data)")]
    UnsupportedEd25519Layout,
    #[msg("attestation was not signed by the pinned risk-engine attester")]
    WrongAttester,
    #[msg("signed message does not match the submitted attestation")]
    AttestationMessageMismatch,
    #[msg("committee quorum not met for this attestation")]
    QuorumNotMet,
    #[msg("attester committee configuration is invalid")]
    InvalidQuorum,
    #[msg("decision does not permit credit release")]
    NotEligibleForCredit,
    #[msg("attestation is not a LIQUIDATE decision")]
    NotLiquidationAttestation,
    #[msg("liquidation requires the facility to be publicly INELIGIBLE first")]
    LiquidationNotArmed,
    #[msg("vault has no locked collateral")]
    VaultNotLocked,
    #[msg("attestation commitment does not match the vault's current commitment")]
    CommitmentMismatch,
    #[msg("attestation policy does not match the vault policy")]
    PolicyMismatch,
    #[msg("attestation has expired")]
    StaleAttestation,
    #[msg("attestation nonce does not match the vault's portfolio-state version")]
    NonceMismatch,
    #[msg("attestation nonce is not newer than the last consumed nonce")]
    NonceNotIncreasing,
    #[msg("invalid decision value")]
    InvalidDecision,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("repay amount exceeds outstanding credit")]
    RepayExceedsOutstanding,
}
