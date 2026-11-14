use near_sdk::{AccountId, NearToken, ext_contract, json_types::U128, near};

/// JSON-compatible mirror of `near_sdk_contract_tools::mt::MtTransferApproval`:
/// a tuple of `(owner_id, approval_id)`. The world crate passes `None`; the
/// type exists so the ext-call signature stays wire-compatible without pulling
/// the token-tools crate into the world wasm.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MtTransferApproval(pub AccountId, pub u32);

/// JSON-compatible mirror of the NEP-145 storage balance record.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageBalance {
    pub total: NearToken,
    pub available: NearToken,
}

#[ext_contract(ext_items)]
pub trait ExtItems {
    fn mint(&self, receiver_id: AccountId, token_id: String, amount: U128, memo: Option<String>);

    fn burn(&self, owner_id: AccountId, token_id: String, amount: U128);

    fn mt_transfer(
        &self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<MtTransferApproval>,
        memo: Option<String>,
    );

    fn storage_deposit(
        &self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance;
}

#[ext_contract(ext_coin)]
pub trait ExtCoin {
    fn ft_transfer(&self, receiver_id: AccountId, amount: U128, memo: Option<String>);

    /// Owner-authorized levy transfer (world is the coin owner).
    fn tax(&self, sender_id: AccountId, receiver_id: AccountId, amount: U128);

    fn storage_deposit(
        &self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance;
}

/// Callback into the world itself; the `#[callback_result]` argument is
/// injected from the preceding promise result, not serialized here.
#[ext_contract(ext_self)]
pub trait ExtSelf {
    fn on_buy_fill(&mut self, fill_id: u64, order_id: u64, buyer: AccountId);
}
