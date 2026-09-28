"use client";

import { ChevronDown, ScrollText } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { saveStoredPolicy, useStoredPolicy } from "@/lib/client/policy-store";
import { EXAMPLE_POLICY, parsePolicyText } from "@/lib/policy/schema";
import { cn } from "@/lib/utils";

/** Collapsible team-policy editor. `onApplied` re-runs the current check with the saved policy. */
export function PolicyEditor({ onApplied }: { onApplied?: () => void }) {
  const stored = useStoredPolicy();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const value = draft ?? stored.text;

  function apply() {
    const text = value.trim();
    if (text) {
      const r = parsePolicyText(text);
      if (!r.ok) return setErrors(r.errors);
    }
    setErrors([]);
    saveStoredPolicy(text);
    setDraft(null);
    onApplied?.();
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm">
        <span className="flex items-center gap-2">
          <ScrollText className="size-4 text-fuchsia-300" aria-hidden />
          Team policy
          <span className={cn("rounded px-1.5 text-[11px]", stored.policy ? "bg-fuchsia-500/15 text-fuchsia-200" : "text-zinc-500")}>
            {stored.policy ? `“${stored.policy.name}” active` : stored.errors.length ? "invalid, not applied" : "none"}
          </span>
        </span>
        <ChevronDown className={cn("size-4 text-zinc-500 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-800 p-3">
          <p className="text-xs text-zinc-400">
            Your team&apos;s rules, checked on every proposal: approved authority holders, actions that must go through Presign Guard, minimum time lock and threshold, approved programs and
            recipients, outflow limits, verified upgrades. Violations raise the verdict; rules that cannot be checked are flagged, never assumed. Kept in this browser only and sent with each check. See{" "}
            <a href="/docs#policy" className="text-fuchsia-300 underline-offset-4 hover:underline">the rule reference</a>.
          </p>
          <Textarea
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            rows={10}
            spellCheck={false}
            maxLength={24_000}
            placeholder='{ "version": 1, "name": "…", … }'
            aria-label="Team policy JSON"
            className="border-zinc-800 bg-zinc-950 font-mono text-xs"
          />
          {errors.length > 0 && (
            <ul role="alert" className="list-disc space-y-0.5 pl-5 text-xs text-red-300">
              {errors.map((e) => <li key={e} className="[overflow-wrap:anywhere]">{e}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={apply}>Save and re-check</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setDraft(JSON.stringify(EXAMPLE_POLICY, null, 2))}>Load example</Button>
            {(stored.text || draft) && (
              <Button type="button" size="sm" variant="ghost" onClick={() => { setDraft(""); setErrors([]); }}>Clear</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
