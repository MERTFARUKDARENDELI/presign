//! Presign Guard — delayed, vetoable execution of critical authorities.
//!
//! A multisig (the proposer) schedules actions; each waits `delay_seconds`
//! and can be vetoed by any single guardian; afterwards anyone can execute
//! it, and only then does the guard signer PDA — which holds the critical
//! authorities — sign. Configuration changes follow the same path. See
//! DESIGN.md for the threat model and invariants.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::Discriminator;

declare_id!("11111111111111111111111111111111");

pub const GUARD_SEED: &[u8] = b"guard";
pub const SIGNER_SEED: &[u8] = b"signer";
pub const ACTION_SEED: &[u8] = b"action";

pub const MAX_GUARDIANS: usize = 10;
pub const MIN_DELAY_SECONDS: u32 = 60;
pub const MAX_DELAY_SECONDS: u32 = 30 * 24 * 60 * 60;
pub const MAX_INSTRUCTIONS: usize = 4;
pub const MAX_ACCOUNTS_PER_INSTRUCTION: usize = 24;
pub const MAX_DATA_LEN: usize = 900;
pub const MAX_MEMO_LEN: usize = 128;

#[program]
pub mod presign_guard {
    use super::*;

    pub fn create_guard(ctx: Context<CreateGuard>, config: GuardConfig) -> Result<()> {
        config.validate()?;
        let guard = &mut ctx.accounts.guard;
        guard.create_key = ctx.accounts.create_key.key();
        guard.proposer = config.proposer;
        guard.guardians = config.guardians;
        guard.delay_seconds = config.delay_seconds;
        guard.action_count = 0;
        guard.bump = ctx.bumps.guard;
        guard.signer_bump = ctx.bumps.guard_signer;
        emit!(GuardCreated {
            guard: guard.key(),
            guard_signer: ctx.accounts.guard_signer.key(),
            proposer: guard.proposer,
            guardians: guard.guardians.clone(),
            delay_seconds: guard.delay_seconds,
        });
        Ok(())
    }

    pub fn schedule(ctx: Context<Schedule>, instructions: Vec<GuardInstruction>, memo: String) -> Result<()> {
        require!(!instructions.is_empty() && instructions.len() <= MAX_INSTRUCTIONS, GuardError::InvalidInstructionCount);
        require!(memo.len() <= MAX_MEMO_LEN, GuardError::MemoTooLong);
        let guard_signer = guard_signer_address(&ctx.accounts.guard.key(), ctx.accounts.guard.signer_bump, ctx.program_id)?;
        let update_config: &[u8] = &crate::instruction::UpdateConfig::DISCRIMINATOR[..];
        for ix in &instructions {
            require!(ix.accounts.len() <= MAX_ACCOUNTS_PER_INSTRUCTION, GuardError::TooManyAccounts);
            require!(ix.data.len() <= MAX_DATA_LEN, GuardError::DataTooLong);
            // The guard signer is the only signature an action can carry.
            for meta in &ix.accounts {
                require!(!meta.is_signer || meta.pubkey == guard_signer, GuardError::ForeignSigner);
            }
            // The only call into Guard itself is a configuration change (so config waits like everything else).
            if ix.program_id == crate::ID {
                require!(ix.data.starts_with(update_config), GuardError::SelfCallNotAllowed);
            }
        }

        let now = Clock::get()?.unix_timestamp;
        let guard = &mut ctx.accounts.guard;
        let action = &mut ctx.accounts.action;
        action.guard = guard.key();
        action.index = guard.action_count;
        action.proposer = ctx.accounts.proposer.key();
        action.rent_payer = ctx.accounts.payer.key();
        action.scheduled_at = now;
        action.eta = now.checked_add(i64::from(guard.delay_seconds)).ok_or(GuardError::Overflow)?;
        action.status = ActionStatus::Pending;
        action.vetoed_by = None;
        action.executed_at = 0;
        action.memo = memo;
        action.instructions = instructions;
        action.bump = ctx.bumps.action;
        guard.action_count = guard.action_count.checked_add(1).ok_or(GuardError::Overflow)?;

        emit!(ActionScheduled { guard: action.guard, action: action.key(), index: action.index, eta: action.eta, memo: action.memo.clone() });
        Ok(())
    }

    pub fn veto(ctx: Context<Veto>) -> Result<()> {
        let guardian = ctx.accounts.guardian.key();
        require!(ctx.accounts.guard.guardians.contains(&guardian), GuardError::NotGuardian);
        // A guardian cannot block its own removal; it can still never execute anything.
        let update_config: &[u8] = &crate::instruction::UpdateConfig::DISCRIMINATOR[..];
        for ix in &ctx.accounts.action.instructions {
            if ix.program_id == crate::ID && ix.data.starts_with(update_config) {
                let config = GuardConfig::try_from_slice(&ix.data[update_config.len()..]).map_err(|_| GuardError::InvalidConfig)?;
                require!(config.guardians.contains(&guardian), GuardError::CannotVetoOwnRemoval);
            }
        }
        let action = &mut ctx.accounts.action;
        action.status = ActionStatus::Vetoed;
        action.vetoed_by = Some(guardian);
        emit!(ActionVetoed { guard: action.guard, action: action.key(), index: action.index, guardian });
        Ok(())
    }

    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let action = &mut ctx.accounts.action;
        action.status = ActionStatus::Cancelled;
        emit!(ActionCancelled { guard: action.guard, action: action.key(), index: action.index });
        Ok(())
    }

    pub fn execute<'info>(ctx: Context<'_, '_, 'info, 'info, Execute<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.action.eta, GuardError::TooEarly);

        // Mark executed before any cross-program call.
        let instructions = ctx.accounts.action.instructions.clone();
        {
            let action = &mut ctx.accounts.action;
            action.status = ActionStatus::Executed;
            action.executed_at = now;
        }

        let guard_key = ctx.accounts.guard.key();
        let signer_bump = [ctx.accounts.guard.signer_bump];
        let seeds: &[&[u8]] = &[SIGNER_SEED, guard_key.as_ref(), &signer_bump];
        let guard_signer = ctx.accounts.guard_signer.to_account_info();

        for ix in instructions {
            let mut infos = Vec::with_capacity(ix.accounts.len() + 1);
            let mut metas = Vec::with_capacity(ix.accounts.len());
            for meta in &ix.accounts {
                infos.push(if meta.pubkey == guard_signer.key() { guard_signer.clone() } else { find_account(ctx.remaining_accounts, &meta.pubkey)? });
                metas.push(AccountMeta { pubkey: meta.pubkey, is_signer: meta.is_signer, is_writable: meta.is_writable });
            }
            infos.push(find_account(ctx.remaining_accounts, &ix.program_id)?);
            invoke_signed(&Instruction { program_id: ix.program_id, accounts: metas, data: ix.data }, &infos, &[seeds])?;
        }

        let action = &ctx.accounts.action;
        emit!(ActionExecuted { guard: action.guard, action: action.key(), index: action.index });
        Ok(())
    }

    pub fn update_config(ctx: Context<UpdateConfig>, config: GuardConfig) -> Result<()> {
        config.validate()?;
        let guard = &mut ctx.accounts.guard;
        guard.proposer = config.proposer;
        guard.guardians = config.guardians;
        guard.delay_seconds = config.delay_seconds;
        emit!(ConfigUpdated { guard: guard.key(), proposer: guard.proposer, guardians: guard.guardians.clone(), delay_seconds: guard.delay_seconds });
        Ok(())
    }

    pub fn close_action(_ctx: Context<CloseAction>) -> Result<()> {
        Ok(())
    }
}

fn find_account<'info>(accounts: &[AccountInfo<'info>], key: &Pubkey) -> Result<AccountInfo<'info>> {
    accounts.iter().find(|a| a.key == key).cloned().ok_or_else(|| error!(GuardError::MissingAccount))
}

// ---------------------------------------------------------------- accounts

#[account]
#[derive(InitSpace)]
pub struct Guard {
    pub create_key: Pubkey,
    /// The only key that can schedule (the multisig vault).
    pub proposer: Pubkey,
    /// Any one of them can veto a pending action.
    #[max_len(MAX_GUARDIANS)]
    pub guardians: Vec<Pubkey>,
    pub delay_seconds: u32,
    pub action_count: u64,
    pub bump: u8,
    pub signer_bump: u8,
}

pub fn guard_signer_address(guard: &Pubkey, signer_bump: u8, program_id: &Pubkey) -> Result<Pubkey> {
    Pubkey::create_program_address(&[SIGNER_SEED, guard.as_ref(), &[signer_bump]], program_id).map_err(|_| error!(GuardError::InvalidSigner))
}

#[account]
pub struct Action {
    pub guard: Pubkey,
    pub index: u64,
    pub proposer: Pubkey,
    pub rent_payer: Pubkey,
    pub scheduled_at: i64,
    pub eta: i64,
    pub status: ActionStatus,
    pub vetoed_by: Option<Pubkey>,
    pub executed_at: i64,
    pub memo: String,
    pub instructions: Vec<GuardInstruction>,
    pub bump: u8,
}

impl Action {
    pub fn space(instructions: &[GuardInstruction], memo: &str) -> usize {
        let ixs: usize = instructions.iter().map(|ix| 32 + 4 + ix.accounts.len() * GuardAccountMeta::SIZE + 4 + ix.data.len()).sum();
        8 + 32 + 8 + 32 + 32 + 8 + 8 + 1 + (1 + 32) + 8 + (4 + memo.len()) + (4 + ixs) + 1
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ActionStatus {
    Pending,
    Executed,
    Vetoed,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct GuardInstruction {
    pub program_id: Pubkey,
    pub accounts: Vec<GuardAccountMeta>,
    pub data: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct GuardAccountMeta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

impl GuardAccountMeta {
    pub const SIZE: usize = 32 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct GuardConfig {
    pub proposer: Pubkey,
    pub guardians: Vec<Pubkey>,
    pub delay_seconds: u32,
}

impl GuardConfig {
    pub fn validate(&self) -> Result<()> {
        require!(!self.guardians.is_empty() && self.guardians.len() <= MAX_GUARDIANS, GuardError::InvalidGuardians);
        for (i, g) in self.guardians.iter().enumerate() {
            require!(!self.guardians[..i].contains(g), GuardError::DuplicateGuardian);
        }
        require!((MIN_DELAY_SECONDS..=MAX_DELAY_SECONDS).contains(&self.delay_seconds), GuardError::InvalidDelay);
        Ok(())
    }
}

// ---------------------------------------------------------------- contexts

#[derive(Accounts)]
pub struct CreateGuard<'info> {
    #[account(init, payer = payer, space = 8 + Guard::INIT_SPACE, seeds = [GUARD_SEED, create_key.key().as_ref()], bump)]
    pub guard: Account<'info, Guard>,
    /// CHECK: PDA that will hold the critical authorities; only its bump is stored.
    #[account(seeds = [SIGNER_SEED, guard.key().as_ref()], bump)]
    pub guard_signer: UncheckedAccount<'info>,
    pub create_key: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(instructions: Vec<GuardInstruction>, memo: String)]
pub struct Schedule<'info> {
    #[account(mut, has_one = proposer @ GuardError::NotProposer)]
    pub guard: Account<'info, Guard>,
    #[account(
        init,
        payer = payer,
        space = Action::space(&instructions, &memo),
        seeds = [ACTION_SEED, guard.key().as_ref(), &guard.action_count.to_le_bytes()],
        bump
    )]
    pub action: Account<'info, Action>,
    pub proposer: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Veto<'info> {
    pub guard: Account<'info, Guard>,
    #[account(mut, has_one = guard, constraint = action.status == ActionStatus::Pending @ GuardError::NotPending)]
    pub action: Account<'info, Action>,
    pub guardian: Signer<'info>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(has_one = proposer @ GuardError::NotProposer)]
    pub guard: Account<'info, Guard>,
    #[account(mut, has_one = guard, constraint = action.status == ActionStatus::Pending @ GuardError::NotPending)]
    pub action: Account<'info, Action>,
    pub proposer: Signer<'info>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    /// Not `mut` here: a scheduled `update_config` writes it through the CPI.
    pub guard: Account<'info, Guard>,
    #[account(mut, has_one = guard, constraint = action.status == ActionStatus::Pending @ GuardError::NotPending)]
    pub action: Account<'info, Action>,
    /// CHECK: the guard signer PDA, verified by seeds.
    #[account(seeds = [SIGNER_SEED, guard.key().as_ref()], bump = guard.signer_bump)]
    pub guard_signer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut)]
    pub guard: Account<'info, Guard>,
    #[account(seeds = [SIGNER_SEED, guard.key().as_ref()], bump = guard.signer_bump)]
    pub guard_signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseAction<'info> {
    pub guard: Account<'info, Guard>,
    #[account(
        mut,
        has_one = guard,
        has_one = rent_payer,
        close = rent_payer,
        constraint = action.status != ActionStatus::Pending @ GuardError::StillPending
    )]
    pub action: Account<'info, Action>,
    /// CHECK: receives the rent; must be the account that paid it (has_one).
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------- events

#[event]
pub struct GuardCreated {
    pub guard: Pubkey,
    pub guard_signer: Pubkey,
    pub proposer: Pubkey,
    pub guardians: Vec<Pubkey>,
    pub delay_seconds: u32,
}

#[event]
pub struct ActionScheduled {
    pub guard: Pubkey,
    pub action: Pubkey,
    pub index: u64,
    pub eta: i64,
    pub memo: String,
}

#[event]
pub struct ActionVetoed {
    pub guard: Pubkey,
    pub action: Pubkey,
    pub index: u64,
    pub guardian: Pubkey,
}

#[event]
pub struct ActionCancelled {
    pub guard: Pubkey,
    pub action: Pubkey,
    pub index: u64,
}

#[event]
pub struct ActionExecuted {
    pub guard: Pubkey,
    pub action: Pubkey,
    pub index: u64,
}

#[event]
pub struct ConfigUpdated {
    pub guard: Pubkey,
    pub proposer: Pubkey,
    pub guardians: Vec<Pubkey>,
    pub delay_seconds: u32,
}

// ---------------------------------------------------------------- errors

#[error_code]
pub enum GuardError {
    #[msg("Only the proposer can do this")]
    NotProposer,
    #[msg("Only a guardian can veto")]
    NotGuardian,
    #[msg("The action is not pending")]
    NotPending,
    #[msg("The action is still pending")]
    StillPending,
    #[msg("The delay has not passed yet")]
    TooEarly,
    #[msg("An action needs 1 to 4 instructions")]
    InvalidInstructionCount,
    #[msg("Too many accounts in one instruction")]
    TooManyAccounts,
    #[msg("Instruction data is too long")]
    DataTooLong,
    #[msg("Memo is too long")]
    MemoTooLong,
    #[msg("Only the guard signer may sign a scheduled instruction")]
    ForeignSigner,
    #[msg("An action may only call update_config on Guard itself")]
    SelfCallNotAllowed,
    #[msg("A guardian cannot veto its own removal")]
    CannotVetoOwnRemoval,
    #[msg("Guardians must be 1 to 10 keys")]
    InvalidGuardians,
    #[msg("Duplicate guardian")]
    DuplicateGuardian,
    #[msg("Delay must be between 60 seconds and 30 days")]
    InvalidDelay,
    #[msg("Invalid configuration data")]
    InvalidConfig,
    #[msg("An account referenced by the action was not provided")]
    MissingAccount,
    #[msg("Invalid guard signer")]
    InvalidSigner,
    #[msg("Arithmetic overflow")]
    Overflow,
}
