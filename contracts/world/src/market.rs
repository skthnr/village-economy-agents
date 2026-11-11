use crate::tick::TICKS_PER_DAY;

pub const INITIAL_PRICE_INDEX: [(&str, u64); 18] = [
    ("wheat", 2),
    ("flour", 5),
    ("bread", 3),
    ("meat", 8),
    ("milk", 2),
    ("iron_tools", 15),
    ("coal", 3),
    ("iron_ore", 4),
    ("timber", 3),
    ("firewood", 2),
    ("herbs", 1),
    ("medicine", 10),
    ("ale", 3),
    ("meal", 6),
    ("cloth", 5),
    ("furniture", 12),
    ("eggs", 1),
    ("vegetables", 2),
];

pub const PRICE_RING_CAP: usize = 10;
pub const ORDER_TTL: u64 = 16;

pub fn initial_price(item: &str) -> Option<u64> {
    INITIAL_PRICE_INDEX
        .iter()
        .find(|(known, _)| *known == item)
        .map(|(_, price)| *price)
}

pub fn order_id(tick: u64, seq: u64) -> u64 {
    (tick << 20) | seq
}

pub fn fill_id(tick: u64, seq: u64) -> u64 {
    (tick << 20) | seq
}

pub fn expires_at(tick: u64) -> u64 {
    tick + ORDER_TTL
}

pub fn push_price(ring: &mut Vec<u64>, price: u64) {
    ring.push(price);
    if ring.len() > PRICE_RING_CAP {
        let excess = ring.len() - PRICE_RING_CAP;
        ring.drain(0..excess);
    }
}

pub fn mean_price(ring: &[u64]) -> Option<u64> {
    let count = ring.len();
    if count == 0 {
        return None;
    }
    let sum: u128 = ring.iter().map(|price| *price as u128).sum();
    let rounded = (sum + (count as u128) / 2) / count as u128;
    Some(u64::try_from(rounded).unwrap_or(u64::MAX))
}

pub fn trade_volume_slot(tick: u64) -> usize {
    (tick % TICKS_PER_DAY) as usize
}
