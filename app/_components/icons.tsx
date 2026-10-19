import {
  ArrowRight,
  ChevronDown,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Hash,
  LoaderCircle,
  Mail,
  SquareKanban,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

/* One shared line-icon set (Lucide). Status is never color alone: every
   semantic color pairs with one of these glyphs plus a label. */

export type { LucideIcon };

export const SourceIcons = {
  jira: SquareKanban,
  email: Mail,
  slack: Hash,
} as const;

export type SourceKindKey = keyof typeof SourceIcons;

export function SourceIcon({ source, size = 20 }: { source: string; size?: number }) {
  const Icon = SourceIcons[source as SourceKindKey] ?? Mail;
  return <Icon size={size} strokeWidth={2} aria-hidden />;
}

/** Verification / conflict states. */
export const StatusIcons = {
  verified: CircleCheck,
  needs_check: TriangleAlert,
  conflict: CircleX,
  recorded: Circle,
  pending: Circle,
  running: LoaderCircle,
  error: CircleAlert,
} as const;

export type StatusKind = keyof typeof StatusIcons;

export function StatusIcon({
  status,
  size = 14,
  className,
}: {
  status: StatusKind;
  size?: number;
  className?: string;
}) {
  const Icon = StatusIcons[status];
  return <Icon size={size} strokeWidth={2.25} aria-hidden className={className} />;
}

export const ActionIcons = {
  next: ArrowRight,
  wait: Clock,
  chevron: ChevronDown,
  alert: TriangleAlert,
  conflict: CircleX,
  info: CircleAlert,
} as const;

export type ActionKind = keyof typeof ActionIcons;

export function ActionIcon({ kind, size = 18, className }: { kind: ActionKind; size?: number; className?: string }) {
  const Icon = ActionIcons[kind];
  return <Icon size={size} strokeWidth={2} aria-hidden className={className} />;
}
