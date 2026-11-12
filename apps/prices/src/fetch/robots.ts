/**
 * robots.txt, honoured before every request. The ruling behind it: PepSpotter reads vendors'
 * public shop feeds with an honest user-agent, and an honest agent does what the file says.
 *
 * Rules follow the REP as Google documents it: the group for our agent token wins over `*`;
 * within a group the LONGEST matching path pattern decides, Allow winning a tie; `*` is a
 * wildcard and `$` anchors the end. A missing or unreachable file allows everything — a
 * policy we cannot read is not a policy we can break.
 */
import type { FetchText } from "./types.ts";

export type RobotsSource = "fetched" | "absent" | "unreachable";

export interface RobotsPolicy {
  origin: string;
  source: RobotsSource;
  allows(path: string): boolean;
}

interface Rule {
  allow: boolean;
  pattern: string;
}

function patternToRegExp(pattern: string): RegExp {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "$") re += "$";
    else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(re);
}

/** Parse a robots.txt body into the rule set that applies to `agent`. */
export function parseRobots(text: string, agent: string, origin = "", source: RobotsSource = "fetched"): RobotsPolicy {
  const wanted = agent.toLowerCase();
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "disallow" || key === "allow") current.rules.push({ allow: key === "allow", pattern: value });
  }
  const matches = (a: string) => a !== "*" && (wanted.startsWith(a) || a.startsWith(wanted));
  const ours = groups.filter((g) => g.agents.some(matches));
  const star = groups.filter((g) => g.agents.includes("*"));
  const rules = (ours.length ? ours : star).flatMap((g) => g.rules).filter((r) => r.pattern !== "");
  const compiled = rules.map((r) => ({ ...r, re: patternToRegExp(r.pattern) }));

  return {
    origin,
    source,
    allows(path: string): boolean {
      let best: (Rule & { re: RegExp }) | null = null;
      for (const r of compiled) {
        if (!r.re.test(path)) continue;
        if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
      }
      return best ? best.allow : true;
    },
  };
}

/** Fetch and parse `<origin>/robots.txt`. Never throws; an unreadable file allows everything. */
export async function loadRobots(origin: string, fetchText: FetchText, agent = "PepforumsBot"): Promise<RobotsPolicy> {
  const url = `${origin.replace(/\/$/, "")}/robots.txt`;
  const res = await fetchText(url, { accept: "text/plain" });
  if (res.state === "hit" && typeof res.body === "string") return parseRobots(res.body, agent, origin, "fetched");
  if (res.state === "miss") return parseRobots("", agent, origin, "absent");
  return parseRobots("", agent, origin, "unreachable");
}
