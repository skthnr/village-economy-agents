use near_sdk::{AccountId, json_types::U128, near};

use crate::state::{Season, ViewItemQty, WealthEntry};

#[near(event_json(standard = "eidolon"))]
pub enum Event {
    #[event_version("1.0.0")]
    TickStarted {
        tick: u64,
        time: String,
        season: Season,
        weather: String,
    },

    #[event_version("1.0.0")]
    ActionResolved {
        agent: AccountId,
        action_type: String,
        text: Option<String>,
        result: String,
        location: String,
    },

    #[event_version("1.0.0")]
    TradeCompleted {
        tick: u64,
        order_id: u64,
        trade_id: u64,
        buyer: AccountId,
        seller: AccountId,
        item: String,
        quantity: U128,
        price_per_unit: U128,
        total: U128,
    },

    #[event_version("1.0.0")]
    ProductionCompleted {
        tick: u64,
        agent: AccountId,
        item: String,
        qty: U128,
    },

    #[event_version("1.0.0")]
    OrderPosted {
        order_id: u64,
        agent_id: AccountId,
        order_type: String,
        item: String,
        quantity: U128,
        price: U128,
    },

    #[event_version("1.0.0")]
    OrderExpired {
        order_id: u64,
        agent_id: AccountId,
        order_type: String,
        item: String,
        quantity: U128,
        price: U128,
    },

    #[event_version("1.0.0")]
    OrderCancelled {
        order_id: u64,
        agent_id: AccountId,
        order_type: String,
        item: String,
        quantity: U128,
        price: U128,
    },

    #[event_version("1.0.0")]
    DawnSnapshotTaken {
        tick: u64,
        day: u8,
        season: Season,
        total_wealth: U128,
        gini_bps: u32,
        gdp: U128,
        price_index: Vec<ViewItemQty>,
        scarcity_alerts: Vec<String>,
        wealth: Vec<WealthEntry>,
    },
}
