/**
 * Official active StelLive roster.
 *
 * `id` is intentionally stable and is used for UI state. `channelId` is the
 * public CHZZK channel identifier; no playback or CDN identifiers are kept.
 */
export const STELLIVE_MEMBERS = [
  {
    id: "yuni",
    name: "아야츠노 유니",
    channelId: "45e71a76e949e16a34764deb962f9d9f",
    group: "EVERYS",
    accent: "#8B5CF6",
  },
  {
    id: "huya",
    name: "사키하네 후야",
    channelId: "36ddb9bb4f17593b60f1b63cec86611d",
    group: "EVERYS",
    accent: "#7C3AED",
  },
  {
    id: "hina",
    name: "시라유키 히나",
    channelId: "b044e3a3b9259246bc92e863e7d3f3b8",
    group: "UNIVERSE",
    accent: "#F472B6",
  },
  {
    id: "mashiro",
    name: "네네코 마시로",
    channelId: "4515b179f86b67b4981e16190817c580",
    group: "UNIVERSE",
    accent: "#D4A574",
  },
  {
    id: "lize",
    name: "아카네 리제",
    channelId: "4325b1d5bbc321fad3042306646e2e50",
    group: "UNIVERSE",
    accent: "#DC2626",
  },
  {
    id: "tabi",
    name: "아라하시 타비",
    channelId: "a6c4ddb09cdb160478996007bff35296",
    group: "UNIVERSE",
    accent: "#3B82F6",
  },
  {
    id: "shibuki",
    name: "텐코 시부키",
    channelId: "64d76089fba26b180d9c9e48a32600d9",
    group: "CLICHÉ",
    accent: "#F59E0B",
  },
  {
    id: "rin",
    name: "아오쿠모 린",
    channelId: "516937b5f85cbf2249ce31b0ad046b0f",
    group: "CLICHÉ",
    accent: "#38BDF8",
  },
  {
    id: "nana",
    name: "하나코 나나",
    channelId: "4d812b586ff63f8a2946e64fa860bbf5",
    group: "CLICHÉ",
    accent: "#FB7185",
  },
  {
    id: "riko",
    name: "유즈하 리코",
    channelId: "8fd39bb8de623317de90654718638b10",
    group: "CLICHÉ",
    accent: "#84CC16",
  },
];

/**
 * Frequently watched channels that should be available from the same GUI but
 * are not part of the official StelLive roster.
 */
export const FEATURED_CHANNELS = [
  {
    id: "gangji",
    name: "강지",
    platform: "chzzk",
    channelId: "b5ed5db484d04faf4d150aedd362f34b",
    group: "함께 보기",
    accent: "#22C55E",
  },
  {
    id: "heavy",
    name: "헤비",
    platform: "youtube",
    channelId: "UCPUcv2Zv9WhH6y8H1A9uWfg",
    group: "함께 보기",
    accent: "#EF4444",
  },
];

export const STREAM_PRESETS = [
  ...STELLIVE_MEMBERS.map((member) => ({ ...member, platform: "chzzk" })),
  ...FEATURED_CHANNELS,
];

export const PRESET_GROUP_ORDER = ["EVERYS", "UNIVERSE", "CLICHÉ", "함께 보기"];
