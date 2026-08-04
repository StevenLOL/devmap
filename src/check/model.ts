// Issue model (single CheckResult contract). PRD §9.3.
import type { Check, Severity, Kind } from "../types";

export function makeCheck(
  id: string,
  kind: Kind,
  severity: Severity,
  label: string,
  detail: string,
  path: string[] = [],
  fix?: Check["Fix"],
): Check {
  const c: Check = { ID: id, Kind: kind, Severity: severity, Label: label, Detail: detail, Path: path };
  if (fix) c.Fix = fix;
  return c;
}
