//! Confidential collateral vault for tokenized equities.
//!
//! HACKATHON PROTOTYPE — not production code.
//!
//! The vault locks Token-2022 collateral for an institution and stores ONLY a
//! hash commitment to the institution's (client-encrypted) portfolio snapshot.
//! Exact quantities, NAV, weights and risk metrics never live in program state;
//! they are computed off-chain by authorized risk engines that sign margin
//! attestations consumed by the `credit_gate` program.
//!
//! Access model:
//!   * `institution`  — immutable vault identity (PDA seed); public knowledge.
//!   * `controller`   — the key that actually signs institution actions
//!                      (deposit / withdraw / commit). Defaults to the
//!                      institution key, rotatable via recovery.
//!   * `recovery_authority` — backup key that can rotate `controller` if the
//!                      institution loses access.
//!   * `liquidation_authority` — the credit layer (credit_gate PDA). It can
//!                      freeze withdrawals while credit is outstanding and
//!                      seize collateral when a valid liquidation attestation
//!                      authorizes it.
//!
//! Known, documented leak: collateral sits in vault-owned token accounts whose
//! balances are publicly readable on Solana (private ingress is a roadmap
//! item, not faked here).

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("F5vxqZkc4tL4RxMjapgA4LM1qL3mskKur4RY6pjeyy4L");

#[program]
pub mod confidential_vault {
    use super::*;

    /// Create a public risk policy. Policies are PUBLIC data: the parameters
    /// are what a lender's margin policy requires; they reveal nothing about
    /// any single portfolio.
    pub fn initialize_policy(
        ctx: Context<InitializePolicy>,
        policy_id: [u8; 8],
        params: PolicyParams,
        assets: Vec<PolicyAsset>,
    ) -> Result<()> {
        require!(!assets.is_empty(), VaultError::EmptyPolicyAssets);
        let policy = &mut ctx.accounts.policy;
        policy.policy_id = policy_id;
        policy.authority = ctx.accounts.authority.key();
        policy.params = params;
        policy.assets = assets;
        emit!(PolicyInitialized {
            policy: policy.key(),
            policy_id,
        });
        Ok(())
    }

    /// Policy authority may re-tune prototype risk parameters.
    pub fn update_policy(ctx: Context<UpdatePolicy>, params: PolicyParams) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        policy.params = params;
        emit!(PolicyUpdated { policy: policy.key() });
        Ok(())
    }

    /// Open a confidential collateral vault for the institution.
    ///
    /// `recovery_authority` is the backup key that can rotate the controller;
    /// `liquidation_authority` is the credit layer's PDA that may freeze
    /// withdrawals and seize collateral on a valid liquidation attestation.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        recovery_authority: Pubkey,
        liquidation_authority: Pubkey,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.institution = ctx.accounts.institution.key();
        vault.controller = ctx.accounts.institution.key();
        vault.recovery_authority = recovery_authority;
        vault.liquidation_authority = liquidation_authority;
        vault.policy = ctx.accounts.policy.key();
        vault.bump = ctx.bumps.vault;
        vault.collateral_locked = false;
        vault.withdrawal_locked = false;
        vault.commitment = [0u8; 32];
        vault.commitment_nonce = 0;
        vault.last_commit_slot = 0;
        vault.deposit_count = 0;
        emit!(VaultInitialized {
            vault: vault.key(),
            institution: vault.institution,
        });
        Ok(())
    }

    /// Institution rotates its controller key (key rotation).
    pub fn set_controller(ctx: Context<VaultControllerAuth>, new_controller: Pubkey) -> Result<()> {
        require!(
            !ctx.accounts.vault.withdrawal_locked,
            VaultError::WithdrawalLocked
        );
        let vault = &mut ctx.accounts.vault;
        vault.controller = new_controller;
        emit!(ControllerRotated {
            vault: vault.key(),
            controller: new_controller,
        });
        Ok(())
    }

    /// Recovery authority rotates the controller if the institution lost access.
    pub fn recover_controller(
        ctx: Context<VaultRecoveryAuth>,
        new_controller: Pubkey,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.controller = new_controller;
        emit!(ControllerRecovered {
            vault: vault.key(),
            controller: new_controller,
        });
        Ok(())
    }

    /// Institution sets/rotates the recovery authority.
    pub fn set_recovery_authority(
        ctx: Context<VaultControllerAuth>,
        new_recovery: Pubkey,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.recovery_authority = new_recovery;
        emit!(RecoveryAuthoritySet {
            vault: vault.key(),
            recovery_authority: new_recovery,
        });
        Ok(())
    }

    /// Lock collateral: move tokens into the vault's custody ATA.
    /// Publicly visible: that tokens moved (see README leak section).
    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        let policy = &ctx.accounts.policy;
        require!(
            policy.assets.iter().any(|a| a.mint == ctx.accounts.mint.key()),
            VaultError::MintNotInPolicy
        );

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                to: ctx.accounts.custody.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.controller.to_account_info(),
            },
        );
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        let vault = &mut ctx.accounts.vault;
        vault.collateral_locked = true;
        vault.deposit_count = vault.deposit_count.saturating_add(1);
        emit!(CollateralDeposited { vault: vault.key() });
        Ok(())
    }

    /// Register a hash commitment to the current portfolio snapshot.
    /// `portfolio_hash` = sha256(client-encrypted portfolio blob ++ domain tag),
    /// computed off-chain. Program state never sees quantities.
    pub fn commit_portfolio(ctx: Context<CommitPortfolio>, portfolio_hash: [u8; 32]) -> Result<()> {
        require!(portfolio_hash != [0u8; 32], VaultError::ZeroCommitment);
        let vault = &mut ctx.accounts.vault;
        require!(vault.collateral_locked, VaultError::VaultNotLocked);
        vault.commitment = portfolio_hash;
        vault.commitment_nonce = vault.commitment_nonce.saturating_add(1);
        vault.last_commit_slot = Clock::get()?.slot;
        emit!(PortfolioCommitmentUpdated {
            vault: vault.key(),
            nonce: vault.commitment_nonce,
        });
        Ok(())
    }

    /// Withdraw collateral back to the controller.
    /// BLOCKED while the credit layer holds a withdrawal lock (i.e. while a
    /// credit facility is outstanding). That lock is applied by credit_gate
    /// on credit release and released on full repayment.
    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        require!(
            !ctx.accounts.vault.withdrawal_locked,
            VaultError::WithdrawalLocked
        );

        let institution_key = ctx.accounts.vault.institution;
        let seeds: &[&[u8]] = &[b"vault", institution_key.as_ref(), b"v2", &[ctx.accounts.vault.bump]];
        let signer_seeds = &[seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.custody.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        emit!(CollateralWithdrawn { vault: ctx.accounts.vault.key() });
        Ok(())
    }

    /// CREDIT LAYER ONLY (gate PDA signs via CPI): freeze or unfreeze
    /// institution withdrawals. Locked while credit is outstanding.
    pub fn set_withdrawal_gate(ctx: Context<VaultCreditAuth>, locked: bool) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.withdrawal_locked = locked;
        emit!(WithdrawalGateSet {
            vault: vault.key(),
            locked,
        });
        Ok(())
    }

    /// CREDIT LAYER ONLY (gate PDA signs via CPI) and only on a valid
    /// liquidation attestation: seize `amount` units of `mint` from custody
    /// and move them to the liquidation receiver (the lender side).
    /// This is the prototype's enforcement path — a production system would
    /// run an auction and account value precisely.
    pub fn liquidate_custody(ctx: Context<LiquidateCustody>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        let institution_key = ctx.accounts.vault.institution;
        let seeds: &[&[u8]] = &[b"vault", institution_key.as_ref(), b"v2", &[ctx.accounts.vault.bump]];
        let signer_seeds = &[seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.custody.to_account_info(),
                to: ctx.accounts.receiver.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        emit!(CollateralLiquidated {
            vault: ctx.accounts.vault.key(),
            mint: ctx.accounts.mint.key(),
            amount,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct PolicyAsset {
    pub mint: Pubkey,
    /// e.g. SPYx 8000 (80%), AAPLx 7000, NVDAx 6000 in the initial policy.
    pub advance_rate_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct SessionFactor {
    /// Factor applied while the US equity market is open (e.g. 10000 = 1.00).
    pub market_open_bps: u16,
    /// Extended/after-hours trading.
    pub extended_hours_bps: u16,
    /// Underlying market closed (overnight, weekend).
    pub market_closed_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct ConcentrationParams {
    /// A single asset above this weight of gross NAV is penalized (4000 = 40%).
    pub threshold_bps: u16,
    /// Multiplier applied to the penalized asset's eligible value (7500 = 0.75).
    pub penalty_bps: u16,
}

/// Prototype risk parameters. These are DEMO ASSUMPTIONS, not production risk
/// parameters. Kept in one account so they are configurable, not hard-coded.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct PolicyParams {
    pub session: SessionFactor,
    pub concentration: ConcentrationParams,
    /// Health-factor floor for releasing NEW credit and for staying COMPLIANT
    /// (20000 = 2.0x). Between this and `ineligible_hf_bps` the public
    /// status is MARGIN_CALL.
    pub credit_hf_bps: u16,
    /// Below this health factor the status is INELIGIBLE.
    pub ineligible_hf_bps: u16,
    /// Feed freshness window, in slots, taken from the oracle accounts.
    pub max_staleness_slots: u64,
}

#[account]
#[derive(InitSpace)]
pub struct RiskPolicy {
    pub policy_id: [u8; 8],
    pub authority: Pubkey,
    pub params: PolicyParams,
    #[max_len(8)]
    pub assets: Vec<PolicyAsset>,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// Immutable vault identity (PDA seed). Never changes, even on recovery.
    pub institution: Pubkey,
    /// The key that signs institution actions. Rotatable via recovery.
    pub controller: Pubkey,
    /// Backup key that can rotate the controller.
    pub recovery_authority: Pubkey,
    /// Credit layer PDA: may freeze withdrawals and seize on liquidation.
    pub liquidation_authority: Pubkey,
    pub policy: Pubkey,
    pub bump: u8,
    pub collateral_locked: bool,
    /// Set by the credit layer while credit is outstanding.
    pub withdrawal_locked: bool,
    /// sha256 over the client-encrypted portfolio snapshot (32 zero bytes =
    /// no snapshot committed yet). This is the ONLY portfolio-derived data on
    /// chain: a commitment, not a disclosure.
    pub commitment: [u8; 32],
    /// Program-counted snapshot version. Attestations must carry the current
    /// value, which both binds them to this portfolio state and makes them
    /// strictly non-replayable.
    pub commitment_nonce: u64,
    pub last_commit_slot: u64,
    pub deposit_count: u16,
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(policy_id: [u8; 8])]
pub struct InitializePolicy<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + RiskPolicy::INIT_SPACE,
        seeds = [b"policy", authority.key().as_ref(), &policy_id[..]],
        bump
    )]
    pub policy: Account<'info, RiskPolicy>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"policy", authority.key().as_ref(), &policy.policy_id[..]],
        bump,
        has_one = authority
    )]
    pub policy: Account<'info, RiskPolicy>,
}

#[derive(Accounts)]
#[instruction(recovery_authority: Pubkey, liquidation_authority: Pubkey)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub institution: Signer<'info>,
    #[account(
        init,
        payer = institution,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", institution.key().as_ref(), b"v2"],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(constraint = !policy.assets.is_empty())]
    pub policy: Account<'info, RiskPolicy>,
    pub system_program: Program<'info, System>,
}

/// Shared constraint set for institution-side actions: the CONTROLLER signs,
/// the vault PDA is derived from the immutable institution identity.
#[derive(Accounts)]
pub struct VaultControllerAuth<'info> {
    pub controller: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault.institution.as_ref(), b"v2"],
        bump,
        constraint = vault.controller == controller.key()
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct VaultRecoveryAuth<'info> {
    pub recovery_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault.institution.as_ref(), b"v2"],
        bump,
        constraint = vault.recovery_authority == recovery_authority.key()
    )]
    pub vault: Account<'info, Vault>,
}

/// Credit layer (gate PDA) authenticates by signing the CPI.
#[derive(Accounts)]
pub struct VaultCreditAuth<'info> {
    pub gate_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault.institution.as_ref(), b"v2"],
        bump,
        constraint = vault.liquidation_authority == gate_authority.key()
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.institution.as_ref(), b"v2"],
        bump,
        constraint = vault.controller == controller.key()
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub controller: Signer<'info>,
    #[account(address = vault.policy)]
    pub policy: Account<'info, RiskPolicy>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// Funded from the controller's own wallet account.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = controller,
        associated_token::token_program = token_program,
    )]
    pub source: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = controller,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub custody: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CommitPortfolio<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.institution.as_ref(), b"v2"],
        bump,
        constraint = vault.controller == controller.key()
    )]
    pub vault: Account<'info, Vault>,
    pub controller: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.institution.as_ref(), b"v2"],
        bump,
        constraint = vault.controller == controller.key(),
        constraint = !vault.withdrawal_locked @ VaultError::WithdrawalLocked
    )]
    pub vault: Account<'info, Vault>,
    pub controller: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// Withdrawal destination: the controller's own wallet account.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = controller,
        associated_token::token_program = token_program,
    )]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub custody: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LiquidateCustody<'info> {
    /// The credit layer's PDA, signing the CPI from credit_gate.
    pub gate_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault.institution.as_ref(), b"v2"],
        bump,
        constraint = vault.liquidation_authority == gate_authority.key()
    )]
    pub vault: Account<'info, Vault>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub custody: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: liquidation receiver, authorized by the credit layer's own
    /// accounting (the gate PDA authorized this transfer by signing the CPI).
    #[account(mut)]
    pub receiver: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------

#[event]
pub struct PolicyInitialized {
    pub policy: Pubkey,
    pub policy_id: [u8; 8],
}

#[event]
pub struct PolicyUpdated {
    pub policy: Pubkey,
}

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub institution: Pubkey,
}

#[event]
pub struct ControllerRotated {
    pub vault: Pubkey,
    pub controller: Pubkey,
}

#[event]
pub struct ControllerRecovered {
    pub vault: Pubkey,
    pub controller: Pubkey,
}

#[event]
pub struct RecoveryAuthoritySet {
    pub vault: Pubkey,
    pub recovery_authority: Pubkey,
}

#[event]
pub struct WithdrawalGateSet {
    pub vault: Pubkey,
    pub locked: bool,
}

#[event]
pub struct CollateralLiquidated {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

/// Deliberately carries no amount/mint: the raw token ledger already exposes
/// transfers; our event surface adds nothing portfolio-specific.
#[event]
pub struct CollateralDeposited {
    pub vault: Pubkey,
}

#[event]
pub struct CollateralWithdrawn {
    pub vault: Pubkey,
}

#[event]
pub struct PortfolioCommitmentUpdated {
    pub vault: Pubkey,
    pub nonce: u64,
}

#[error_code]
pub enum VaultError {
    #[msg("policy must include at least one asset")]
    EmptyPolicyAssets,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("mint is not part of the risk policy")]
    MintNotInPolicy,
    #[msg("commitment hash must be non-zero")]
    ZeroCommitment,
    #[msg("vault has no locked collateral")]
    VaultNotLocked,
    #[msg("withdrawals are locked while credit is outstanding")]
    WithdrawalLocked,
}
