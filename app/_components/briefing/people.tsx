import type { Person } from "@/lib/report/briefing";

export const PERSON_COLORS = [
  "var(--person-0)",
  "var(--person-1)",
  "var(--person-2)",
  "var(--person-3)",
  "var(--person-4)",
  "var(--person-5)",
  "var(--person-6)",
  "var(--person-7)",
];

export function initials(name: string): string {
  const source = name.includes("@") ? name.split("@")[0].replace(/[._-]+/g, " ") : name;
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function Avatar({ name, colorIndex, large = false }: { name: string; colorIndex: number; large?: boolean }) {
  return (
    <span
      className={`avatar${large ? " avatar-lg" : ""}`}
      style={{ background: PERSON_COLORS[colorIndex % PERSON_COLORS.length] }}
      role="img"
      aria-label={name}
    >
      {initials(name)}
    </span>
  );
}

export function PersonLabel({
  name,
  role,
  colorIndex,
  large = false,
}: {
  name: string;
  role?: string;
  colorIndex: number;
  large?: boolean;
}) {
  return (
    <span className="person">
      <Avatar name={name} colorIndex={colorIndex} large={large} />
      <span>{name}</span>
      {role && <span className="person-role">{role}</span>}
    </span>
  );
}

export function colorFor(people: Person[], name: string): number {
  return people.find((person) => person.name === name)?.colorIndex ?? 0;
}

export function roleFor(people: Person[], name: string): string | undefined {
  return people.find((person) => person.name === name)?.role;
}
