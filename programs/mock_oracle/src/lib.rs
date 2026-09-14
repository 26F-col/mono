//! Mock price oracle with a market-session flag.
//!
//! DEMO ONLY. This stands in for a production oracle (e.g. Pyth) behind the
//! `PriceOracle` interface implemented in `/sdk`. Prices are in USD cents per
//! share. Every tokenized equity gets its own `PriceFeed` PDA keyed by symbol.
//!
//! The market-session flag models the core risk of tokenized equities: the
//! token market trades 24/7 while the underlying market does not, so borrowing
//! capacity must degrade outside regular US market hours and when the feed is
//! stale.

use anchor_lang::prelude::*;

declare_id!("2fYvWaHejSYB1RNzsjrpQBMkmSNTXbYV9FWkRYXSj6Do");

pub const SESSION_OPEN: u8 = 0;
pub const SESSION_EXTENDED: u8 = 1;
pub const SESSION_CLOSED: u8 = 2;

#[program]
pub mod mock_oracle {
    use super::*;

    pub fn initialize_feed(
        ctx: Context<InitializeFeed>,
        symbol: [u8; 8],
        price_cents: u64,
        staleness_window_slots: u64,
    ) -> Result<()> {
        let feed = &mut ctx.accounts.feed;
        feed.authority = ctx.accounts.authority.key();
        feed.symbol = symbol;
        feed.price_cents = price_cents;
        feed.publish_slot = Clock::get()?.slot;
        feed.market_session = SESSION_OPEN;
        feed.staleness_window_slots = staleness_window_slots;
        feed.outage = false;
        feed.bump = ctx.bumps.feed;
        Ok(())
    }

    /// Publish a new price; refreshes freshness (a real oracle publish does both)
    /// and clears any outage flag.
    pub fn set_price(ctx: Context<SetPrice>, price_cents: u64) -> Result<()> {
        let feed = &mut ctx.accounts.feed;
        feed.price_cents = price_cents;
        feed.publish_slot = Clock::get()?.slot;
        feed.outage = false;
        emit!(PriceUpdated {
            symbol: feed.symbol,
            price_cents,
        });
        Ok(())
    }

    /// Move the underlying market between open / extended / closed.
    pub fn set_market_session(ctx: Context<SetPrice>, market_session: u8) -> Result<()> {
        require!(market_session <= SESSION_CLOSED, MockOracleError::InvalidSession);
        let feed = &mut ctx.accounts.feed;
        feed.market_session = market_session;
        emit!(MarketSessionChanged {
            symbol: feed.symbol,
            market_session,
        });
        Ok(())
    }

    /// DEMO CONTROL ONLY: flag the feed as in outage so it reads as stale.
    /// Cleared by the next real publish (set_price).
    pub fn simulate_stale_feed(ctx: Context<SetPrice>) -> Result<()> {
        let feed = &mut ctx.accounts.feed;
        feed.outage = true;
        emit!(FeedMarkedStale { symbol: feed.symbol });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(symbol: [u8; 8])]
pub struct InitializeFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + PriceFeed::INIT_SPACE,
        seeds = [b"price", &symbol[..], b"v2"],
        bump
    )]
    pub feed: Account<'info, PriceFeed>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"price", &feed.symbol[..], b"v2"], bump, has_one = authority)]
    pub feed: Account<'info, PriceFeed>,
}

#[account]
#[derive(InitSpace)]
pub struct PriceFeed {
    pub authority: Pubkey,
    pub symbol: [u8; 8],
    /// USD cents per share (price * 100).
    pub price_cents: u64,
    pub publish_slot: u64,
    /// 0 = US market open, 1 = extended hours, 2 = closed / weekend.
    pub market_session: u8,
    pub staleness_window_slots: u64,
    /// DEMO: oracle outage flag (until the next publish).
    pub outage: bool,
    pub bump: u8,
}

impl PriceFeed {
    pub fn is_stale_at(&self, slot: u64) -> bool {
        self.outage || slot.saturating_sub(self.publish_slot) > self.staleness_window_slots
    }
}

#[event]
pub struct PriceUpdated {
    pub symbol: [u8; 8],
    pub price_cents: u64,
}

#[event]
pub struct MarketSessionChanged {
    pub symbol: [u8; 8],
    pub market_session: u8,
}

#[event]
pub struct FeedMarkedStale {
    pub symbol: [u8; 8],
}

#[error_code]
pub enum MockOracleError {
    #[msg("invalid market session value")]
    InvalidSession,
}
