/**
 * How a person is shown everywhere (header menu, member lists, admin): the display name when there is a real one,
 * otherwise the e-mail. Initials come from the name, or from the e-mail's local part ("jane.doe@…" → JD, "ciso@…" → CI)
 * — never from the domain, and never a placeholder.
 */
export interface PersonLike {
  email: string;
  displayName?: string | null;
}

export function personName(p: PersonLike): string {
  const name = p.displayName?.trim();
  return name && name.toLowerCase() !== p.email.toLowerCase() ? name : p.email;
}

/** The secondary line under the name: the e-mail when a name is shown, nothing when the e-mail already is the name. */
export function personSubtitle(p: PersonLike): string | null {
  return personName(p) === p.email ? null : p.email;
}

export function personInitials(p: PersonLike): string {
  const name = personName(p);
  if (name !== p.email) {
    const words = name.split(/\s+/).filter(Boolean);
    const letters = words.length >= 2 ? words[0]![0]! + words[words.length - 1]![0]! : words[0]?.slice(0, 2) ?? "";
    return letters.toUpperCase() || "?";
  }
  const local = p.email.split("@")[0] ?? "";
  const parts = local.split(/[._+-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? "").slice(0, 2);
  return letters.toUpperCase() || "?";
}
