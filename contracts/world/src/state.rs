use near_sdk::{
    json_types::U128,
    near,
    AccountId,
};

/// One item and a raw integer quantity. Used for stored state.
pub type ItemQty = (String, u128);

/// One item and a JSON-facing quantity. Used in views and events.
pub type ViewItemQty = (String, U128);

#[near(serializers = [json, borsh])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Season {
    Spring,
    Summer,
    Autumn,
    Winter,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderSide {
    Sell,
    Buy,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub id: u64,
    pub agent_id: AccountId,
    pub side: OrderSide,
    pub item: String,
    pub quantity: u128,
    pub price: u128,
    pub posted_tick: u64,
    pub expires_at: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Trade {
    pub id: u64,
    pub order_id: u64,
    pub tick: u64,
    pub buyer: AccountId,
    pub seller: AccountId,
    pub item: String,
    pub quantity: u128,
    pub price_per_unit: u128,
    pub total: u128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuyFill {
    pub fill_id: u64,
    pub order_id: u64,
    pub buyer: AccountId,
    pub quantity: u128,
    pub cost: u128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BodyState {
    pub hunger: u8,
    pub energy: u8,
    pub sleep_quality: u8,
    pub sickness: u8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentProfile {
    pub skill: String,
    pub home: String,
    pub work: String,
    pub work_start: u8,
    pub work_end: u8,
    pub wallet: u128,
    pub inventory: Vec<ItemQty>,
    pub tool: Option<String>,
    pub tool_durability: u8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedAgent {
    pub name: String,
    pub profile: AgentProfile,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionType {
    MoveTo,
    Speak,
    Produce,
    Eat,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Action {
    pub action_type: ActionType,
    pub text: Option<String>,
    pub item: Option<String>,
    pub quantity: Option<U128>,
    pub price: Option<U128>,
    pub max_price: Option<U128>,
    pub order_id: Option<u64>,
    pub location: Option<String>,
    pub target: Option<AccountId>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldView {
    pub tick: u64,
    pub time: String,
    pub weather: String,
    pub season: Season,
    pub day_of_season: u8,
    pub locations: Vec<(AccountId, String)>,
    pub bodies: Vec<(AccountId, BodyState)>,
    pub last_snapshot: EconomySnapshot,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EconomySnapshot {
    pub tick: u64,
    pub day: u8,
    pub season: Season,
    pub total_wealth: U128,
    pub gini_bps: u32,
    pub gdp: U128,
    pub price_index: Vec<ViewItemQty>,
    pub scarcity_alerts: Vec<String>,
    pub wealth: Vec<WealthEntry>,
}

impl EconomySnapshot {
    pub fn genesis() -> Self {
        Self {
            tick: 1,
            day: 1,
            season: Season::Spring,
            total_wealth: U128(0),
            gini_bps: 0,
            gdp: U128(0),
            price_index: Vec::new(),
            scarcity_alerts: Vec::new(),
            wealth: Vec::new(),
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WealthEntry {
    pub agent: AccountId,
    pub wallet: U128,
    pub inventory_value: U128,
}
