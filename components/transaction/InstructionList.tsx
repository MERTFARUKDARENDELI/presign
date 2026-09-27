import { defangLinks } from "@/lib/security/text-signals";
import type { DecodedInstruction } from "@/lib/transaction/types";
import { Address } from "@/components/security/badges";

/** Instruction fields for display. Memo text is untrusted: its links are shown only as defanged hosts. */
function infoValue(key: string, value: string | null): string {
  if (value === null) return "null";
  return key === "memo" ? defangLinks(value) : value;
}

/** Decoder metadata (keys starting with "_") is not an instruction field. */
const visibleInfo = (info: Record<string, string | null>) => Object.entries(info).filter(([k]) => !k.startsWith("_"));

const IDL_HINT = "Names come from the program's own published IDL: they state intent, not verified behavior.";

export function InstructionList({ instructions }: { instructions: DecodedInstruction[] }) {
  return (
    <ol className="space-y-2">
      {instructions.map((i) => (
        <li key={i.index} className="rounded-lg bg-zinc-950 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-zinc-100">#{i.index} {i.type}</span>
            <span className="text-zinc-500">{i.programName}</span>
            {!i.parsed && <span className="rounded bg-amber-500/15 px-1.5 text-amber-200">not decoded — intent unknown ({i.dataLength} bytes)</span>}
            {i.info._decodedBy && <span className="rounded bg-sky-500/15 px-1.5 text-sky-200" title={IDL_HINT}>named via on-chain IDL</span>}
          </div>
          {visibleInfo(i.info).length > 0 && (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
              {visibleInfo(i.info).map(([k, v]) => (
                <div key={k} className="contents"><dt className="text-zinc-500">{k}</dt><dd className="break-all text-zinc-300">{infoValue(k, v)}</dd></div>
              ))}
            </dl>
          )}
          <div className="mt-1 flex flex-wrap gap-1">
            {i.accounts.map((a, idx) => (
              <span key={idx} className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-400">
                {a.name}: <Address value={a.address} />{a.writable ? " ✎" : ""}{a.signer ? " ✍" : ""}
              </span>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function InnerInstructionList({ instructions }: { instructions: DecodedInstruction[] }) {
  return (
    <ol className="space-y-1 text-xs">
      {instructions.map((i) => (
        <li key={i.index} className="rounded-md bg-zinc-950 px-2 py-1.5">
          <span className="text-zinc-500">under #{i.parentIndex} →</span> <span className="font-mono text-zinc-200">{i.type}</span>{" "}
          <span className="text-zinc-500">{i.programName}</span>
          {i.programTrust === "unknown" && !i.info._decodedBy && <span className="ml-1 rounded bg-amber-500/15 px-1 text-amber-200">unverified</span>}
          {i.info._decodedBy && <span className="ml-1 rounded bg-sky-500/15 px-1 text-sky-200" title={IDL_HINT}>via on-chain IDL</span>}
          {visibleInfo(i.info).length > 0 && (
            <div className="mt-0.5 break-all font-mono text-[11px] text-zinc-400">{visibleInfo(i.info).map(([k, v]) => `${k}=${infoValue(k, v)}`).join("  ")}</div>
          )}
        </li>
      ))}
    </ol>
  );
}
