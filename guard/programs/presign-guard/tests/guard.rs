//! Program tests (LiteSVM): the invariants in guard/DESIGN.md, including the
//! two veto bypasses fixed before the first compile.

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::instruction::{AccountMeta, Instruction},
        AccountDeserialize, AnchorSerialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    presign_guard::{Action, ActionStatus, Guard, GuardAccountMeta, GuardConfig, GuardError, GuardInstruction},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const DELAY: u32 = 3_600;
const SOL: u64 = 1_000_000_000;

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    proposer: Keypair,
    guardians: Vec<Keypair>,
    outsider: Keypair,
    guard: Pubkey,
    signer: Pubkey,
}

fn system_program() -> Pubkey {
    anchor_lang::system_program::ID
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &presign_guard::id()).0
}

fn action_pda(guard: &Pubkey, index: u64) -> Pubkey {
    pda(&[presign_guard::ACTION_SEED, guard.as_ref(), &index.to_le_bytes()])
}

fn code(e: GuardError) -> String {
    format!("Custom({})", u32::from(e))
}

impl Env {
    /// A guard with `n` guardians and a one-hour delay; the guard signer holds 1 SOL.
    fn new(n: usize) -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/presign_guard.so"));
        svm.add_program(presign_guard::id(), bytes).unwrap();
        let payer = Keypair::new();
        let proposer = Keypair::new();
        let outsider = Keypair::new();
        let guardians: Vec<Keypair> = (0..n).map(|_| Keypair::new()).collect();
        for k in [&payer, &proposer, &outsider].into_iter().chain(guardians.iter()) {
            svm.airdrop(&k.pubkey(), 10 * SOL).unwrap();
        }
        let create_key = Keypair::new();
        let guard = pda(&[presign_guard::GUARD_SEED, create_key.pubkey().as_ref()]);
        let signer = pda(&[presign_guard::SIGNER_SEED, guard.as_ref()]);
        let mut env = Env { svm, payer, proposer, guardians, outsider, guard, signer };
        let config = GuardConfig { proposer: env.proposer.pubkey(), guardians: env.guardians.iter().map(|g| g.pubkey()).collect(), delay_seconds: DELAY };
        let ix = Instruction::new_with_bytes(
            presign_guard::id(),
            &presign_guard::instruction::CreateGuard { config }.data(),
            presign_guard::accounts::CreateGuard { guard, guard_signer: signer, create_key: create_key.pubkey(), payer: env.payer.pubkey(), system_program: system_program() }.to_account_metas(None),
        );
        env.send(&[ix], &[&create_key]).unwrap();
        env.svm.airdrop(&signer, SOL).unwrap();
        env
    }

    /// Sends with `payer` as fee payer plus `signers`; a fresh blockhash each time so identical transactions are distinct.
    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        self.send_as(&self.payer.insecure_clone(), ixs, signers)
    }

    fn send_as(&mut self, fee_payer: &Keypair, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&fee_payer.pubkey()), &self.svm.latest_blockhash());
        let mut all: Vec<&Keypair> = vec![fee_payer];
        all.extend(signers.iter().copied().filter(|k| k.pubkey() != fee_payer.pubkey()));
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all).map_err(|e| format!("{e:?}"))?;
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
    }

    fn guard_account(&self) -> Guard {
        Guard::try_deserialize(&mut self.svm.get_account(&self.guard).unwrap().data.as_slice()).unwrap()
    }

    fn action(&self, index: u64) -> Action {
        Action::try_deserialize(&mut self.svm.get_account(&action_pda(&self.guard, index)).unwrap().data.as_slice()).unwrap()
    }

    fn warp(&mut self, seconds: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += seconds;
        self.svm.set_sysvar(&clock);
    }

    fn schedule_ix(&self, by: Pubkey, instructions: Vec<GuardInstruction>) -> Instruction {
        let index = self.guard_account().action_count;
        Instruction::new_with_bytes(
            presign_guard::id(),
            &presign_guard::instruction::Schedule { instructions, memo: "test".into() }.data(),
            presign_guard::accounts::Schedule { guard: self.guard, action: action_pda(&self.guard, index), proposer: by, payer: self.payer.pubkey(), system_program: system_program() }.to_account_metas(None),
        )
    }

    /// Schedules as the proposer; returns the action index.
    fn schedule(&mut self, instructions: Vec<GuardInstruction>) -> Result<u64, String> {
        let index = self.guard_account().action_count;
        let ix = self.schedule_ix(self.proposer.pubkey(), instructions);
        let proposer = self.proposer.insecure_clone();
        self.send(&[ix], &[&proposer]).map(|_| index)
    }

    fn veto(&mut self, index: u64, guardian: &Keypair) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            presign_guard::id(),
            &presign_guard::instruction::Veto {}.data(),
            presign_guard::accounts::Veto { guard: self.guard, action: action_pda(&self.guard, index), guardian: guardian.pubkey() }.to_account_metas(None),
        );
        self.send(&[ix], &[guardian])
    }

    fn cancel(&mut self, index: u64) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            presign_guard::id(),
            &presign_guard::instruction::Cancel {}.data(),
            presign_guard::accounts::Cancel { guard: self.guard, action: action_pda(&self.guard, index), proposer: self.proposer.pubkey() }.to_account_metas(None),
        );
        let proposer = self.proposer.insecure_clone();
        self.send(&[ix], &[&proposer])
    }

    /// Execute as the outsider (anyone may), passing the accounts the action references — as Presign's client does.
    fn execute(&mut self, index: u64, skip: Option<Pubkey>) -> Result<(), String> {
        let action = self.action(index);
        let self_call = action.instructions.iter().any(|ix| ix.program_id == presign_guard::id());
        let signer_writable = action.instructions.iter().flat_map(|ix| ix.accounts.iter()).any(|m| m.pubkey == self.signer && m.is_writable);
        let mut metas = presign_guard::accounts::Execute { guard: self.guard, action: action_pda(&self.guard, index), guard_signer: self.signer }.to_account_metas(None);
        metas[0].is_writable = self_call;
        metas[2].is_writable = signer_writable;
        let mut remaining: Vec<AccountMeta> = Vec::new();
        let mut add = |key: Pubkey, writable: bool| {
            if Some(key) == skip || key == self.signer {
                return;
            }
            match remaining.iter_mut().find(|m| m.pubkey == key) {
                Some(m) => m.is_writable |= writable,
                None => remaining.push(AccountMeta { pubkey: key, is_signer: false, is_writable: writable }),
            }
        };
        for ix in &action.instructions {
            add(ix.program_id, false);
            for m in &ix.accounts {
                add(m.pubkey, m.is_writable);
            }
        }
        metas.extend(remaining);
        let ix = Instruction::new_with_bytes(presign_guard::id(), &presign_guard::instruction::Execute {}.data(), metas);
        let outsider = self.outsider.insecure_clone();
        self.send_as(&outsider, &[ix], &[])
    }

    /// System transfer from the guard signer (it holds lamports), signed by the guard through `execute`.
    fn pay(&self, to: Pubkey, lamports: u64) -> GuardInstruction {
        let mut data = vec![2, 0, 0, 0];
        data.extend_from_slice(&lamports.to_le_bytes());
        GuardInstruction {
            program_id: system_program(),
            accounts: vec![GuardAccountMeta { pubkey: self.signer, is_signer: true, is_writable: true }, GuardAccountMeta { pubkey: to, is_signer: false, is_writable: true }],
            data,
        }
    }

    fn update_config(&self, proposer: Pubkey, guardians: Vec<Pubkey>, delay_seconds: u32) -> GuardInstruction {
        GuardInstruction {
            program_id: presign_guard::id(),
            accounts: vec![GuardAccountMeta { pubkey: self.guard, is_signer: false, is_writable: true }, GuardAccountMeta { pubkey: self.signer, is_signer: true, is_writable: false }],
            data: presign_guard::instruction::UpdateConfig { config: GuardConfig { proposer, guardians, delay_seconds } }.data(),
        }
    }

    fn g(&self, i: usize) -> Pubkey {
        self.guardians[i].pubkey()
    }
}

#[test]
fn create_guard_stores_the_configuration() {
    let env = Env::new(2);
    let g = env.guard_account();
    assert_eq!(g.proposer, env.proposer.pubkey());
    assert_eq!(g.guardians, vec![env.g(0), env.g(1)]);
    assert_eq!(g.delay_seconds, DELAY);
    assert_eq!(g.action_count, 0);
}

#[test]
fn only_the_proposer_schedules_and_only_the_guard_signer_signs() {
    let mut env = Env::new(2);
    let recipient = Keypair::new().pubkey();
    // Not the proposer.
    let ix = env.schedule_ix(env.outsider.pubkey(), vec![env.pay(recipient, 1)]);
    let outsider = env.outsider.insecure_clone();
    assert!(env.send(&[ix], &[&outsider]).unwrap_err().contains(&code(GuardError::NotProposer)));
    // A scheduled instruction that needs another signer.
    let mut foreign = env.pay(recipient, 1);
    foreign.accounts[1].is_signer = true;
    assert!(env.schedule(vec![foreign]).unwrap_err().contains(&code(GuardError::ForeignSigner)));
    // A call into Guard other than update_config.
    let veto = GuardInstruction { program_id: presign_guard::id(), accounts: vec![], data: presign_guard::instruction::Veto {}.data() };
    assert!(env.schedule(vec![veto]).unwrap_err().contains(&code(GuardError::SelfCallNotAllowed)));
    // No instructions, or too many.
    assert!(env.schedule(vec![]).unwrap_err().contains(&code(GuardError::InvalidInstructionCount)));
    assert!(env.schedule(vec![env.pay(recipient, 1); 5]).unwrap_err().contains(&code(GuardError::InvalidInstructionCount)));
}

#[test]
fn a_config_change_must_be_exactly_one_valid_config() {
    let mut env = Env::new(2);
    // Trailing bytes: guardians would review one thing while Anchor executes another.
    let mut trailing = env.update_config(env.proposer.pubkey(), vec![env.g(0)], DELAY);
    trailing.data.push(0);
    assert!(env.schedule(vec![trailing]).unwrap_err().contains(&code(GuardError::InvalidConfig)));
    let none = env.update_config(env.proposer.pubkey(), vec![], DELAY);
    assert!(env.schedule(vec![none]).unwrap_err().contains(&code(GuardError::InvalidGuardians)));
    let short = env.update_config(env.proposer.pubkey(), vec![env.g(0)], 10);
    assert!(env.schedule(vec![short]).unwrap_err().contains(&code(GuardError::InvalidDelay)));
    let dup = env.update_config(env.proposer.pubkey(), vec![env.g(0), env.g(0)], DELAY);
    assert!(env.schedule(vec![dup]).unwrap_err().contains(&code(GuardError::DuplicateGuardian)));
}

#[test]
fn execute_waits_for_the_delay_then_anyone_can_run_it_once() {
    let mut env = Env::new(2);
    let recipient = Keypair::new().pubkey();
    let i = env.schedule(vec![env.pay(recipient, SOL / 2)]).unwrap();
    assert_eq!(env.action(i).status, ActionStatus::Pending);
    assert!(env.execute(i, None).unwrap_err().contains(&code(GuardError::TooEarly)));
    env.warp(i64::from(DELAY));
    env.execute(i, None).unwrap();
    assert_eq!(env.svm.get_balance(&recipient), Some(SOL / 2));
    assert_eq!(env.action(i).status, ActionStatus::Executed);
    assert!(env.execute(i, None).unwrap_err().contains(&code(GuardError::NotPending)));
}

#[test]
fn a_missing_account_fails_without_changing_state() {
    let mut env = Env::new(2);
    let recipient = Keypair::new().pubkey();
    let i = env.schedule(vec![env.pay(recipient, 1_000)]).unwrap();
    env.warp(i64::from(DELAY));
    assert!(env.execute(i, Some(recipient)).unwrap_err().contains(&code(GuardError::MissingAccount)));
    assert_eq!(env.action(i).status, ActionStatus::Pending);
    env.execute(i, None).unwrap();
}

#[test]
fn any_guardian_vetoes_until_execution_and_nobody_else_can() {
    let mut env = Env::new(2);
    let recipient = Keypair::new().pubkey();
    let i = env.schedule(vec![env.pay(recipient, 1_000)]).unwrap();
    let outsider = env.outsider.insecure_clone();
    assert!(env.veto(i, &outsider).unwrap_err().contains(&code(GuardError::NotGuardian)));
    env.warp(i64::from(DELAY) + 10);
    // Still vetoable after the delay, until someone executes it.
    let g1 = env.guardians[1].insecure_clone();
    env.veto(i, &g1).unwrap();
    let a = env.action(i);
    assert_eq!(a.status, ActionStatus::Vetoed);
    assert_eq!(a.vetoed_by, Some(env.g(1)));
    assert!(env.execute(i, None).unwrap_err().contains(&code(GuardError::NotPending)));
    assert_eq!(env.svm.get_balance(&recipient), None);
}

#[test]
fn the_proposer_can_cancel_a_pending_action() {
    let mut env = Env::new(2);
    let i = env.schedule(vec![env.pay(Keypair::new().pubkey(), 1_000)]).unwrap();
    env.cancel(i).unwrap();
    assert_eq!(env.action(i).status, ActionStatus::Cancelled);
    env.warp(i64::from(DELAY));
    assert!(env.execute(i, None).unwrap_err().contains(&code(GuardError::NotPending)));
}

#[test]
fn a_compromised_proposer_cannot_strip_the_guardians() {
    let mut env = Env::new(3);
    let attacker = Keypair::new().pubkey();
    let p = env.proposer.pubkey();
    let (g0, g1, g2) = (env.guardians[0].insecure_clone(), env.guardians[1].insecure_clone(), env.guardians[2].insecure_clone());

    // Replace every guardian: each current guardian can still veto.
    let i = env.schedule(vec![env.update_config(p, vec![attacker], DELAY)]).unwrap();
    env.veto(i, &g0).unwrap();

    // Remove two at once: a removed guardian can veto.
    let i = env.schedule(vec![env.update_config(p, vec![env.g(2)], DELAY)]).unwrap();
    env.veto(i, &g1).unwrap();

    // Remove one guardian but shorten the delay: vetoable by that guardian.
    let i = env.schedule(vec![env.update_config(p, vec![env.g(1), env.g(2)], 60)]).unwrap();
    env.veto(i, &g0).unwrap();

    // Remove one guardian and hand the proposer role away: vetoable by that guardian.
    let i = env.schedule(vec![env.update_config(attacker, vec![env.g(1), env.g(2)], DELAY)]).unwrap();
    env.veto(i, &g0).unwrap();

    // A removal bundled with anything else: vetoable by the removed guardian.
    let i = env.schedule(vec![env.update_config(p, vec![env.g(1), env.g(2)], DELAY), env.pay(attacker, 1_000)]).unwrap();
    env.veto(i, &g0).unwrap();

    // Removing one honest guardian at a time: the others can veto.
    let i = env.schedule(vec![env.update_config(p, vec![env.g(1), env.g(2)], DELAY)]).unwrap();
    env.veto(i, &g2).unwrap();
}

#[test]
fn a_guardian_cannot_block_its_own_removal_but_the_others_can() {
    let mut env = Env::new(3);
    let p = env.proposer.pubkey();
    let (g0, g1) = (env.guardians[0].insecure_clone(), env.guardians[1].insecure_clone());
    let i = env.schedule(vec![env.update_config(p, vec![env.g(1), env.g(2)], DELAY)]).unwrap();
    assert!(env.veto(i, &g0).unwrap_err().contains(&code(GuardError::CannotVetoOwnRemoval)));
    env.veto(i, &g1).unwrap();

    // Not vetoed: after the delay the removal executes through the guard itself.
    let i = env.schedule(vec![env.update_config(p, vec![env.g(1), env.g(2)], DELAY * 2)]).unwrap();
    env.warp(i64::from(DELAY));
    env.execute(i, None).unwrap();
    let g = env.guard_account();
    assert_eq!(g.guardians, vec![env.g(1), env.g(2)]);
    assert_eq!(g.delay_seconds, DELAY * 2);
    // The removed guardian has no power left.
    let j = env.schedule(vec![env.pay(Keypair::new().pubkey(), 1)]).unwrap();
    assert!(env.veto(j, &g0).unwrap_err().contains(&code(GuardError::NotGuardian)));
}

#[test]
fn update_config_cannot_be_called_directly() {
    let mut env = Env::new(2);
    let config = GuardConfig { proposer: env.outsider.pubkey(), guardians: vec![env.outsider.pubkey()], delay_seconds: 60 };
    // Instruction data is the discriminator followed by the Borsh config (what Presign decodes and guardians review).
    let data = presign_guard::instruction::UpdateConfig { config: config.clone() }.data();
    let mut borsh = Vec::new();
    config.serialize(&mut borsh).unwrap();
    assert_eq!(&data[8..], borsh.as_slice());
    // Nobody can produce the guard signer's signature outside `execute`.
    let metas = vec![AccountMeta::new(env.guard, false), AccountMeta::new_readonly(env.signer, false)];
    let ix = Instruction::new_with_bytes(presign_guard::id(), &data, metas);
    assert!(env.send(&[ix], &[]).is_err());
    assert_eq!(env.guard_account().proposer, env.proposer.pubkey());
}

#[test]
fn close_action_refuses_pending_and_refunds_only_the_payer() {
    let mut env = Env::new(2);
    let i = env.schedule(vec![env.pay(Keypair::new().pubkey(), 1_000)]).unwrap();
    let close = |env: &Env, rent_payer: Pubkey| {
        Instruction::new_with_bytes(
            presign_guard::id(),
            &presign_guard::instruction::CloseAction {}.data(),
            presign_guard::accounts::CloseAction { guard: env.guard, action: action_pda(&env.guard, i), rent_payer }.to_account_metas(None),
        )
    };
    let ix = close(&env, env.payer.pubkey());
    assert!(env.send(&[ix], &[]).unwrap_err().contains(&code(GuardError::StillPending)));
    env.cancel(i).unwrap();
    let ix = close(&env, env.outsider.pubkey());
    assert!(env.send(&[ix], &[]).is_err());
    let before = env.svm.get_balance(&env.payer.pubkey()).unwrap();
    let ix = close(&env, env.payer.pubkey());
    let outsider = env.outsider.insecure_clone();
    env.send_as(&outsider, &[ix], &[]).unwrap();
    assert!(env.svm.get_balance(&env.payer.pubkey()).unwrap() > before);
    assert!(env.svm.get_account(&action_pda(&env.guard, i)).map_or(true, |a| a.lamports == 0));
}
