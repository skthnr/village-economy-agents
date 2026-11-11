use crate::state::Season;

pub static ALL_ITEMS: [&str; 18] = [
    "wheat",
    "flour",
    "bread",
    "meat",
    "milk",
    "eggs",
    "vegetables",
    "herbs",
    "medicine",
    "iron_ore",
    "coal",
    "iron_tools",
    "timber",
    "firewood",
    "furniture",
    "ale",
    "meal",
    "cloth",
];

pub struct Recipe {
    pub output: &'static str,
    pub base_qty: u128,
    pub inputs: &'static [(&'static str, u128)],
    pub location: &'static str,
    pub skill: &'static str,
    pub needs_tool: bool,
}

/// The 18 origin recipes, in origin table order. Every recipe has one output.
pub static RECIPES: [Recipe; 18] = [
    Recipe {
        output: "wheat",
        base_qty: 4,
        inputs: &[],
        location: "Farm 1",
        skill: "farmer",
        needs_tool: true,
    },
    Recipe {
        output: "milk",
        base_qty: 3,
        inputs: &[],
        location: "Farm 2",
        skill: "cattle",
        needs_tool: false,
    },
    Recipe {
        output: "meat",
        base_qty: 2,
        inputs: &[],
        location: "Farm 2",
        skill: "cattle",
        needs_tool: true,
    },
    Recipe {
        output: "eggs",
        base_qty: 2,
        inputs: &[],
        location: "Farm 3",
        skill: "farmer",
        needs_tool: false,
    },
    Recipe {
        output: "vegetables",
        base_qty: 3,
        inputs: &[],
        location: "Farm 3",
        skill: "farmer",
        needs_tool: true,
    },
    Recipe {
        output: "flour",
        base_qty: 2,
        inputs: &[("wheat", 3)],
        location: "Mill",
        skill: "miller",
        needs_tool: false,
    },
    Recipe {
        output: "bread",
        base_qty: 4,
        inputs: &[("flour", 1)],
        location: "Bakery",
        skill: "baker",
        needs_tool: false,
    },
    Recipe {
        output: "iron_tools",
        base_qty: 1,
        inputs: &[("iron_ore", 2), ("coal", 1)],
        location: "Forge",
        skill: "blacksmith",
        needs_tool: false,
    },
    Recipe {
        output: "furniture",
        base_qty: 1,
        inputs: &[("timber", 3)],
        location: "Carpenter Shop",
        skill: "carpenter",
        needs_tool: true,
    },
    Recipe {
        output: "medicine",
        base_qty: 1,
        inputs: &[("herbs", 3)],
        location: "Healer's Hut",
        skill: "healer",
        needs_tool: false,
    },
    Recipe {
        output: "ale",
        base_qty: 4,
        inputs: &[("wheat", 2)],
        location: "Tavern",
        skill: "tavern",
        needs_tool: false,
    },
    Recipe {
        output: "meal",
        base_qty: 3,
        inputs: &[("meat", 1), ("vegetables", 1)],
        location: "Tavern",
        skill: "tavern",
        needs_tool: false,
    },
    Recipe {
        output: "cloth",
        base_qty: 1,
        inputs: &[],
        location: "Seamstress Cottage",
        skill: "seamstress",
        needs_tool: false,
    },
    Recipe {
        output: "timber",
        base_qty: 3,
        inputs: &[],
        location: "Forest",
        skill: "woodcutter",
        needs_tool: true,
    },
    Recipe {
        output: "firewood",
        base_qty: 4,
        inputs: &[],
        location: "Forest",
        skill: "woodcutter",
        needs_tool: true,
    },
    Recipe {
        output: "herbs",
        base_qty: 2,
        inputs: &[],
        location: "Forest",
        skill: "healer",
        needs_tool: false,
    },
    Recipe {
        output: "iron_ore",
        base_qty: 3,
        inputs: &[],
        location: "Mine",
        skill: "miner",
        needs_tool: true,
    },
    Recipe {
        output: "coal",
        base_qty: 2,
        inputs: &[],
        location: "Mine",
        skill: "miner",
        needs_tool: true,
    },
];

/// Season multipliers in basis points, in `ALL_ITEMS` order:
/// spring, summer, autumn, winter.
pub static SEASON_BPS: [[u32; 4]; 18] = [
    [1200, 1500, 1000, 0],
    [1000, 1000, 1000, 1000],
    [1000, 1000, 1000, 1000],
    [1000, 1000, 1200, 800],
    [1200, 1000, 800, 600],
    [1500, 1000, 800, 500],
    [1200, 1500, 1000, 0],
    [1500, 1200, 800, 0],
    [1000, 1000, 1000, 1000],
    [1000, 1000, 1000, 800],
    [1000, 1000, 1000, 1200],
    [1000, 1000, 1000, 1000],
    [1000, 1000, 1200, 800],
    [800, 800, 1200, 1500],
    [1000, 1000, 1000, 1000],
    [1000, 1200, 1500, 1000],
    [1000, 1000, 1000, 1000],
    [1000, 1000, 1000, 1200],
];

pub fn canonical_item_rank(item: &str) -> usize {
    ALL_ITEMS
        .iter()
        .position(|known| *known == item)
        .unwrap_or(usize::MAX)
}

pub fn season_multiplier_bps(item: &str, season: &Season) -> u32 {
    let Some(index) = ALL_ITEMS.iter().position(|known| *known == item) else {
        return 1000;
    };
    let column = match season {
        Season::Spring => 0,
        Season::Summer => 1,
        Season::Autumn => 2,
        Season::Winter => 3,
    };
    SEASON_BPS[index][column]
}

pub fn recipe_for(item: &str) -> Option<&'static Recipe> {
    RECIPES.iter().find(|recipe| recipe.output == item)
}

/// Origin quantity math: floor(base x season x event), all factors in
/// thousandths. The origin labor bonus (1.5) only applies to hired laborers,
/// which are deferred in v1, so no labor factor exists here.
pub fn apply_multipliers(base: u128, season_bps: u32, event_bps: u32) -> u128 {
    base * (season_bps as u128) * (event_bps as u128) / 1_000_000
}
