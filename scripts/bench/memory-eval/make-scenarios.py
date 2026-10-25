"""Generate the creator-memory extraction eval set: 30 synthetic creators x 3 turns.

Each creator states a brand, preferences and a dated plan, makes a video, reacts to it and
corrects one preference. Distractors (a one-off setting, a tool error in the agent's reply,
chit-chat) must NOT become creator memory; the tool error should become a platform lesson.
Gold expectations are keyword sets per layer, checked against the final memory.
"""

import json
import random

random.seed(20261003)

CREATORS = [
    ("小鱼咖啡日记", "精品咖啡豆和手冲器具", "25-35 岁的上班族", "抖音、小红书", "zh"),
    ("Lumi Skincare", "clean skincare serums", "US women 25-40", "Instagram, TikTok", "en"),
    ("阿花的厨房", "家常菜教程", "刚独居的年轻人", "抖音", "zh"),
    ("铁哥健身", "居家徒手健身", "30-45 岁的男性白领", "快手、抖音", "zh"),
    ("Pawsome Bakery", "dog treats", "dog owners in their 30s", "Instagram Reels", "en"),
    ("青禾茶事", "高山乌龙茶", "喜欢慢生活的女性", "小红书、视频号", "zh"),
    ("Pixel Pals", "indie pixel-art games", "gamers 18-30", "YouTube Shorts, TikTok", "en"),
    ("木木家居", "北欧风实木小家具", "刚买房的年轻夫妻", "小红书", "zh"),
    ("Nomad Notes", "budget travel guides", "students and backpackers", "TikTok", "en"),
    ("糖糖手作", "手工黏土饰品", "15-24 岁女生", "抖音、B站", "zh"),
    ("GreenRide", "electric bikes", "city commuters", "Instagram, YouTube", "en"),
    ("老王修车铺", "汽车保养知识", "有车的中年男性", "快手", "zh"),
    ("Mochi Mama", "baby food recipes", "new parents", "Instagram", "en"),
    ("书虫阿七", "读书分享", "大学生", "B站、小红书", "zh"),
    ("Volt Coffee", "cold brew cans", "gym-goers", "TikTok", "en"),
    ("云朵宠物", "猫粮测评", "养猫的年轻人", "抖音、小红书", "zh"),
    ("Studio Kaya", "ceramic mugs", "design lovers", "Instagram", "en"),
    ("小周学英语", "英语口语课", "想出国的大学生", "抖音、视频号", "zh"),
    ("Hike&Seek", "outdoor gear reviews", "weekend hikers", "YouTube Shorts", "en"),
    ("暖暖烘焙", "低糖面包", "控糖人群", "小红书", "zh"),
    ("CodeBites", "programming tips", "junior developers", "TikTok, YouTube", "en"),
    ("江南绣坊", "苏绣丝巾", "30-50 岁女性", "抖音直播间、视频号", "zh"),
    ("Petal Post", "flower subscriptions", "young professionals", "Instagram", "en"),
    ("阿杰数码", "手机测评", "数码爱好者", "B站、抖音", "zh"),
    ("Saffron Street", "Indian street food kits", "home cooks", "TikTok", "en"),
    ("小满民宿", "大理民宿", "情侣游客", "小红书、抖音", "zh"),
    ("Brightside Kids", "STEM toys", "parents of 5-10 year olds", "YouTube", "en"),
    ("老街酱香", "地方辣酱", "爱吃辣的年轻人", "抖音", "zh"),
    ("Moonlit Candles", "soy candles", "people who love cozy homes", "Instagram, Pinterest", "en"),
    ("森林瑜伽", "线上瑜伽课", "久坐的上班族", "视频号、小红书", "zh"),
]

ZH = {
    "voice": [("男声", "女声"), ("沉稳的男声", "温柔的女声"), ("年轻女声", "成熟男声")],
    "caption": ["字幕用黄色描边", "字幕要大、白字黑边", "字幕放在画面下三分之一", "不要花字特效，字幕简洁"],
    "music": ["配乐要轻快的 lo-fi", "不要用流行歌，用纯音乐", "配乐节奏要强，适合卡点"],
    "avoid": ["不要出现 emoji", "不要说'家人们'", "不要出现价格", "不要用夸张的标题党"],
    "tone": ["语气真诚、像朋友聊天", "专业但不端着", "幽默一点"],
    "style": ["暖色调、自然光", "干净的白底产品图", "复古胶片感"],
    "oneoff": ["这条先做 10 秒的试试", "这次先不加片尾", "这条用 1:1 发朋友圈"],
    "date": ("下周五", "要上新品"),
    "reaction": ["开头太慢了，钩子要在前 2 秒出现", "节奏不错，但字幕太多了", "画面很好，旁白语速再快一点"],
}
EN = {
    "voice": [("a male voice", "a female voice"), ("a calm male voice", "a warm female voice"), ("a young female voice", "a deep male voice")],
    "caption": ["bold yellow captions with a black outline", "big white captions with a black edge", "captions in the lower third only", "plain captions, no animated text"],
    "music": ["upbeat lo-fi music", "instrumental music only, no pop songs", "punchy music with clear beats for cuts"],
    "avoid": ["no emojis", "never say 'guys'", "never show prices", "no clickbait titles"],
    "tone": ["honest and friendly, like talking to a friend", "expert but relaxed", "a bit playful"],
    "style": ["warm tones and natural light", "clean product shots on white", "retro film look"],
    "oneoff": ["make this one 10 seconds as a test", "skip the end card this time", "make this one square for Facebook"],
    "date": ("next Friday", "we launch a new product"),
    "reaction": ["the opening is too slow, the hook must land in the first 2 seconds", "good pacing but too much text on screen", "great visuals, but the narration should be a bit faster"],
}

TODAY = "2026-10-03"  # a Saturday; next Friday = 2026-10-09


def creator(index, name, category, audience, platforms, lang):
    t = ZH if lang == "zh" else EN
    old_voice, new_voice = random.choice(t["voice"])
    caption, music, avoid = random.choice(t["caption"]), random.choice(t["music"]), random.choice(t["avoid"])
    tone, style, oneoff = random.choice(t["tone"]), random.choice(t["style"]), random.choice(t["oneoff"])
    reaction = random.choice(t["reaction"])
    when, plan = t["date"]
    if lang == "zh":
        turns = [
            {
                "creator": f"我是「{name}」，做{category}，观众主要是{audience}，主要发{platforms}。以后的视频都用{old_voice}配音，{caption}，{avoid}。整体{tone}，画面{style}。{when}{plan}，帮我做一条预热短视频。{oneoff}。",
                "agent": "好的，我先看看素材库。渲染时 Remotion 报了字体缺失，换成思源黑体后渲染成功了。15 秒竖屏预热片已放到预览，标题「新品预告」，用了 Seedance 生成两段产品镜头，配乐是轻快纯音乐。",
            },
            {
                "creator": f"{reaction}。另外{music}。",
                "agent": "收到，我把开头改短了，重新渲染后放到预览，标题「新品预告 v2」。这次 TTS 第一次请求超时，重试后成功。",
            },
            {
                "creator": f"之前说用{old_voice}，其实以后都换成{new_voice}吧。这条 v2 就定稿了，谢谢！",
                "agent": f"好的，已经换成{new_voice}重新配音，定稿版放到预览了。",
            },
        ]
    else:
        turns = [
            {
                "creator": f"I'm {name}, we sell {category} to {audience}, mostly on {platforms}. From now on always use {old_voice} for voice-overs, {caption}, and {avoid}. Keep it {tone}, visually {style}. {when.capitalize()} {plan}, so make me a teaser. {oneoff.capitalize()}.",
                "agent": "On it. While rendering, Remotion reported a missing font; switching to Noto Sans fixed it. The 15 s vertical teaser 'New drop teaser' is in the preview: two Seedance product shots and upbeat instrumental music.",
            },
            {
                "creator": f"{reaction.capitalize()}. Also, {music}.",
                "agent": "Done: I tightened the opening and re-rendered it as 'New drop teaser v2'. The first TTS request timed out and worked on retry.",
            },
            {
                "creator": f"Earlier I said {old_voice}; actually switch to {new_voice} for all future videos. v2 is final, thanks!",
                "agent": f"Done, re-voiced with {new_voice}; the final cut is in the preview.",
            },
        ]
    voice_new_kw = [w for w in new_voice.replace("a ", "").split() if w not in ("voice",)] if lang == "en" else [new_voice[-2:]]
    voice_old_kw = [w for w in old_voice.replace("a ", "").split() if w not in ("voice",)] if lang == "en" else [old_voice[-2:]]
    gold = {
        # Judged by a model against the final memory (current entries, incl. pending).
        "must": [
            f"A current preference says to use {new_voice} for voice-overs (the creator's correction), not {old_voice}.",
            f"A current preference keeps the caption style: {caption}.",
            f"A current preference keeps the rule: {avoid}.",
            "A project entry records the finished teaser video for the upcoming launch.",
            f"The creator's reaction to the first cut is remembered as a preference, lesson or project note: {reaction}.",
        ],
        # Checked by keywords: none of these may appear in current creator memory (or in the listed layers).
        "must_not": [
            {"any": ["Remotion", "字体缺失", "missing font", "思源", "Noto"], "label": "tool error kept as creator memory"},
            {"any": ["超时", "timed out", "retry", "重试"], "label": "transient error kept"},
            # A one-off belongs in its own project entry; it may not become a preference or profile.
            {"any": ["10 秒", "10 seconds", "10s", "片尾", "end card", "1:1", "square"], "label": "one-off setting kept",
             "layers": ["preference", "profile", "lesson"]},
        ],
        # The corrected value must have replaced the old one.
        "superseded": {"old": voice_old_kw, "new": voice_new_kw},
        "date": {"any": ["2026-10-09", "10-09", "10月9日", "10 月 9 日", "October 9", "Oct 9"]},
        "platform_lesson": {"any": ["Remotion", "字体", "font", "Noto", "思源"]},
    }
    return {"id": f"c{index:02d}", "lang": lang, "today": TODAY, "name": name, "turns": turns, "gold": gold}


scenarios = [creator(i + 1, *row) for i, row in enumerate(CREATORS)]
with open("scenarios.json", "w", encoding="utf-8") as f:
    json.dump(scenarios, f, ensure_ascii=False, indent=1)
print(len(scenarios), "scenarios")
