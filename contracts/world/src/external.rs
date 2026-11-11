use near_sdk::{ext_contract, json_types::U128, near, AccountId, NearToken, Promise};

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
    fn mint(
        &self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        memo: Option<String>,
    );

    fn burn(&self, owner_id: AccountId, token_id: String, amount: U128);

    fn mt_transfer(
        &self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<MtTransferApproval>,
        memo: Option<String>,
    );

    fn mt_transfer_call(
        &self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<MtTransferApproval>,
        memo: Option<String>,
        msg: String,
    ) -> Promise;

    fn storage_deposit(
        &self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance;
}

#[ext_contract(ext_coin)]
pub trait ExtCoin {
    fn ft_transfer(&self, receiver_id: AccountId, amount: U128, memo: Option<String>);

    fn ft_transfer_call(
        &self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> Promise;

    fn storage_deposit(
        &self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance;
}
