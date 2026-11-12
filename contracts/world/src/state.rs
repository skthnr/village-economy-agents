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

impl Season {
    pub fn as_str(&self) -> &'static str {
        match self {
            Season::Spring => "spring",
            Season::Summer => "summer",
            Season::Autumn => "autumn",
            Season::Winter => "winter",
        }
    }
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
    /// Fills reserved from this order whose item transfer has not settled.
    /// Internal state only; never part of the JSON order-book shape.
    #[serde(skip)]
    pub pending_fills: u32,
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
    /// Consecutive ticks at hunger 5. `DEAD_STARVATION` is the permanent marker.
    pub starvation_ticks: u8,
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

/// Body section of the agent perception prompt, byte-compatible with
/// `orchestrator/src/perception.ts` `Perception.body`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PerceptionBody {
    pub hunger: u8,
    pub energy: u8,
    pub sleep_quality: u8,
    pub sickness: u8,
}

/// Profile section of the agent perception prompt.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PerceptionProfile {
    pub skill: String,
    pub home: String,
    pub work: String,
    pub work_start: u8,
    pub work_end: u8,
}

/// One inventory line in the perception prompt.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InventoryLine {
    pub item: String,
    pub quantity: U128,
}

/// Wallet + inventory mirror section of the perception prompt.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MirrorView {
    pub wallet: U128,
    pub inventory: Vec<InventoryLine>,
}

/// Equipped tool section of the perception prompt.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolView {
    pub item: String,
    pub durability: u8,
}

/// One price-index line in the perception prompt.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceLine {
    pub item: String,
    pub price: U128,
}

/// JSON view returned by `world::get_perception`; the orchestrator parses this
/// into `Perception` and rejects a missing or mistyped field.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Perception {
    pub tick: u64,
    pub time: String,
    pub season: Season,
    pub weather: String,
    pub location: String,
    pub body: PerceptionBody,
    pub profile: PerceptionProfile,
    pub mirrors: MirrorView,
    pub tool: Option<ToolView>,
    pub price_index: Vec<PriceLine>,
    pub order_book: Vec<Order>,
    pub feedback: Vec<String>,
}
