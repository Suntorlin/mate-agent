// Lines: `ja` (or any language) is what TTS speaks, `zh` is the caption, `box` is what a dialogue box
// types. Keep them separate: 「……」, quotes and ellipses are silent in TTS. `silent: true` + `dur` = a
// text-only beat (no audio). `who` = the role, used for casting.
window.LINES = {
  sage: {
    who: "old sage",
    ja: "ひとりでは きけんじゃ。これを もっていけ。",
    zh: "一个人太危险了，拿上这个。",
    box: ["ひとりでは きけんじゃ！", "これを もっていけ"],
  },
  hero: { who: "hero", ja: "やっと、しゃべれる。", zh: "终于，能说话了。" },
  tag: { who: "hero", ja: "主人公にも、声を。", zh: "给主角，一个声音。", title: "Acme Creative" },
};
// Captions for beats without audio (optional).
window.BEATSUB = {};
