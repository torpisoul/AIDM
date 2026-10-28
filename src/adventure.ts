export function resolveAdventureAction(action: string) {
  const intent = action.toLocaleLowerCase();

  if (/\b(track|tracks|footprints|trail|follow)\b/.test(intent)) {
    return "You follow the small footprints off the road and up to the standing stones. A child's handprint is pressed into the wet clay, and below the hill a lantern flickers in the silent village. Which clue do you pursue?";
  }

  if (/\b(stone|stones|hill|north|bracken)\b/.test(intent)) {
    return "At the standing stones, you find a narrow seam hidden beneath the moss. From inside the hill comes a soft knock—three times—then silence. How do you investigate?";
  }

  if (/\b(village|door|house|enter|building)\b/.test(intent)) {
    return "You step into Briar Glen. Every door stands ajar and supper is still warm, but no one is in sight. Three deliberate knocks sound from beneath the old well. What do you do?";
  }

  if (/\b(call|shout|speak|ask|listen|voice|answer)\b/.test(intent)) {
    return "Your voice carries between the dark houses. A child answers from somewhere near the well: “I’m still here.” A lantern blinks at the edge of the wood. How do you respond?";
  }

  return `You try ${action.trim().replace(/[.!?]+$/, "")}. The forest answers with a faint bell from beyond the road, while a warm light appears in one of Briar Glen’s dark windows. What do you investigate first?`;
}
