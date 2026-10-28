export type StorySettings = {
  premise: string;
  scene: string;
  style: string;
  notes: string;
};

export type StoryTurn = {
  role: "player" | "dm";
  text: string;
};

export const DEFAULT_STORY_SETTINGS: StorySettings = {
  premise: "The party follows the old forest road toward Briar Glen, a village that has gone silent. A missing child, strange footprints, and the old standing stones are tied to the mystery.",
  scene: "The old forest road at dusk, one mile outside Briar Glen. The village is dark. A low hill crowned with standing stones lies to the north.",
  style: "Atmospheric, curious, warm, and concise. Keep narration vivid but easy to speak aloud.",
  notes: "The last daylight slips between the pines. Fresh, small footprints leave the road and head north toward the standing stones.",
};

export const STORY_SETTINGS_KEY = "emberkeep.story-settings.v1";

export function isStorySettings(value: unknown): value is StorySettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Record<string, unknown>;
  return ["premise", "scene", "style", "notes"].every((key) =>
    typeof settings[key] === "string" && settings[key].length <= 4_000);
}
