use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::DateTime;
use serde::Serialize;

struct NewsSource {
    url: &'static str,
    heat: i64,
}

const NEWS_SOURCES: &[NewsSource] = &[
    NewsSource {
        url: "https://news.google.com/rss/search?q=(AI%20OR%20%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD%20OR%20%E7%A7%91%E6%8A%80%20OR%20%E8%B4%A2%E7%BB%8F%20OR%20%E6%B0%91%E7%94%9F%20OR%20%E4%BA%92%E8%81%94%E7%BD%91)%20(%E7%AA%81%E5%8F%91%20OR%20%E5%BF%AB%E8%AE%AF%20OR%20%E5%88%9A%E5%88%9A%20OR%20%E6%9C%80%E6%96%B0)%20when%3A1h&hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
        heat: 5,
    },
    NewsSource {
        url: "https://news.google.com/rss/search?q=(AI%20OR%20%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD%20OR%20%E7%A7%91%E6%8A%80%20OR%20%E8%B4%A2%E7%BB%8F%20OR%20%E6%B0%91%E7%94%9F%20OR%20%E4%BA%92%E8%81%94%E7%BD%91)%20(%E7%AA%81%E5%8F%91%20OR%20%E5%BF%AB%E8%AE%AF%20OR%20%E5%88%9A%E5%88%9A%20OR%20%E6%9C%80%E6%96%B0)%20when%3A6h&hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
        heat: 4,
    },
    NewsSource {
        url: "https://news.google.com/rss/search?q=(AI%20OR%20%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD%20OR%20%E7%A7%91%E6%8A%80%20OR%20%E8%B4%A2%E7%BB%8F%20OR%20%E6%B0%91%E7%94%9F%20OR%20%E4%B8%AD%E6%96%87%E4%BA%92%E8%81%94%E7%BD%91)%20(%E7%83%AD%E7%82%B9%20OR%20%E9%87%8D%E5%A4%A7%20OR%20%E5%8F%91%E5%B8%83%20OR%20%E5%AE%98%E5%AE%A3)%20when%3A1d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
        heat: 3,
    },
    NewsSource {
        url: "https://news.google.com/rss/search?q=(AI%20OR%20artificial%20intelligence%20OR%20OpenAI%20OR%20Nvidia%20OR%20semiconductor%20OR%20global%20tech)%20when%3A1d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
        heat: 2,
    },
    NewsSource {
        url: "https://www.bing.com/news/search?q=AI%20%E7%A7%91%E6%8A%80%20%E8%B4%A2%E7%BB%8F%20%E6%B0%91%E7%94%9F%20%E4%BA%92%E8%81%94%E7%BD%91%20%E7%AA%81%E5%8F%91%20%E6%9C%80%E6%96%B0&format=rss&qft=interval%3d%227%22",
        heat: 2,
    },
    NewsSource {
        url: "https://www.bing.com/news/search?q=AI%20%E7%A7%91%E6%8A%80%20%E8%B4%A2%E7%BB%8F%20%E6%B0%91%E7%94%9F%20%E4%B8%AD%E6%96%87%E4%BA%92%E8%81%94%E7%BD%91%20%E7%83%AD%E7%82%B9&format=rss&qft=interval%3d%227%22",
        heat: 1,
    },
];
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_NEWS_AGE_MS: i64 = 48 * 60 * 60 * 1000;
const FUTURE_SKEW_MS: i64 = 15 * 60 * 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyNewsItem {
    key: String,
    title: String,
    link: String,
    source: Option<String>,
    published_at: Option<String>,
    summary: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyPushDigest {
    news: Vec<DailyNewsItem>,
    quote: Option<String>,
    quote_index: Option<usize>,
    trivia: Option<String>,
    trivia_index: Option<usize>,
    fetched_at: i64,
}

struct ScoredNewsItem {
    item: DailyNewsItem,
    published_ms: i64,
    priority: i64,
    heat: i64,
}

#[tauri::command]
pub async fn daily_push_digest(
    exclude_news_keys: Vec<String>,
    exclude_quote_indices: Vec<usize>,
    exclude_trivia_indices: Vec<usize>,
) -> Result<DailyPushDigest, String> {
    let exclude_news: HashSet<String> = exclude_news_keys.into_iter().collect();
    let news = fetch_news()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|item| !exclude_news.contains(&item.key))
        .take(5)
        .collect();
    let quote_index = pick_unique_index(QUOTES.len(), &exclude_quote_indices);
    let trivia_index = pick_unique_index(TRIVIA.len(), &exclude_trivia_indices);
    Ok(DailyPushDigest {
        news,
        quote: quote_index.map(|idx| QUOTES[idx].to_string()),
        quote_index,
        trivia: trivia_index.map(|idx| TRIVIA[idx].to_string()),
        trivia_index,
        fetched_at: now_ms(),
    })
}

async fn fetch_news() -> Result<Vec<DailyNewsItem>, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .user_agent("Bugzia/0.1 daily digest")
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let now = now_ms();
    let mut candidates = Vec::new();
    let mut key_counts: HashMap<String, i64> = HashMap::new();
    for source_cfg in NEWS_SOURCES {
        let text = match client.get(source_cfg.url).send().await {
            Ok(resp) => resp
                .text()
                .await
                .map_err(|e| format!("read news: {e}"))?,
            Err(_) => continue,
        };
        for block in tag_blocks(&text, "item").into_iter().take(40) {
            let raw_title = tag_value(block, "title")
                .map(clean_xml_text)
                .filter(|s| !s.is_empty());
            let Some(raw_title) = raw_title else {
                continue;
            };
            let link = tag_value(block, "link")
                .map(clean_xml_text)
                .unwrap_or_default();
            let source = tag_value(block, "source")
                .map(clean_xml_text)
                .filter(|s| !s.is_empty());
            let title = clean_news_title(&raw_title, source.as_deref());
            let description = tag_value(block, "description")
                .map(clean_xml_text)
                .unwrap_or_default();
            let haystack = format!("{title} {description}");
            if is_excluded_news(&haystack) || !matches_user_taste(&haystack) {
                continue;
            }
            let key = news_key(&title, &link);
            if key.is_empty() {
                continue;
            }
            let published_at = tag_value(block, "pubDate")
                .map(clean_xml_text)
                .filter(|s| !s.is_empty());
            let Some(published_ms) = published_at.as_deref().and_then(parse_news_time_ms) else {
                continue;
            };
            if published_ms > now + FUTURE_SKEW_MS || now - published_ms > MAX_NEWS_AGE_MS {
                continue;
            }
            let summary = news_summary(&description, source.as_deref());
            *key_counts.entry(key.clone()).or_insert(0) += 1;
            candidates.push(ScoredNewsItem {
                priority: priority_bucket(&haystack),
                heat: source_cfg.heat + keyword_heat(&haystack),
                item: DailyNewsItem {
                    key,
                    title,
                    link,
                    source,
                    published_at,
                    summary,
                },
                published_ms,
            });
        }
    }
    candidates.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| b.published_ms.cmp(&a.published_ms))
            .then_with(|| {
                let b_count = key_counts.get(&b.item.key).copied().unwrap_or(1);
                let a_count = key_counts.get(&a.item.key).copied().unwrap_or(1);
                b_count.cmp(&a_count)
            })
            .then_with(|| b.heat.cmp(&a.heat))
    });
    let mut seen = HashSet::new();
    Ok(candidates
        .into_iter()
        .filter_map(|scored| {
            if seen.insert(scored.item.key.clone()) {
                Some(scored.item)
            } else {
                None
            }
        })
        .take(12)
        .collect())
}

fn parse_news_time_ms(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc2822(text)
        .or_else(|_| DateTime::parse_from_rfc3339(text))
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn keyword_heat(title: &str) -> i64 {
    [
        "突发", "快讯", "刚刚", "最新", "热搜", "现场", "通报", "回应", "宣布", "发布",
        "重大", "首次", "今日", "今天", "今晨", "昨晚",
    ]
    .iter()
    .filter(|word| title.contains(**word))
    .count() as i64
}

fn priority_bucket(text: &str) -> i64 {
    if contains_any(text, &["突发", "快讯", "刚刚", "最新"]) {
        return 4;
    }
    if contains_any(text, &["重大", "首次", "发布", "官宣", "宣布", "今日", "今天", "昨晚"]) {
        return 3;
    }
    if contains_any(text, &["热搜", "热点", "热议", "刷屏", "关注"]) {
        return 2;
    }
    1
}

fn matches_user_taste(text: &str) -> bool {
    contains_any(
        text,
        &[
            "AI",
            "人工智能",
            "大模型",
            "科技",
            "芯片",
            "算力",
            "半导体",
            "机器人",
            "互联网",
            "数码",
            "软件",
            "OpenAI",
            "英伟达",
            "Nvidia",
            "苹果",
            "微软",
            "谷歌",
            "特斯拉",
            "华为",
            "小米",
            "字节",
            "腾讯",
            "阿里",
            "百度",
            "财经",
            "金融",
            "经济",
            "消费",
            "市场",
            "利率",
            "汇率",
            "油价",
            "黄金",
            "财报",
            "民生",
            "医保",
            "社保",
            "就业",
            "住房",
            "教育",
            "交通",
        ],
    )
}

fn is_excluded_news(text: &str) -> bool {
    contains_any(
        text,
        &[
            "明星",
            "八卦",
            "娱乐",
            "综艺",
            "演唱会",
            "体育",
            "足球",
            "篮球",
            "比赛",
            "夺冠",
            "血腥",
            "凶杀",
            "谋杀",
            "命案",
            "尸体",
            "死亡",
            "伤亡",
            "坠亡",
            "车祸",
            "火灾",
            "爆炸",
            "政治争吵",
            "互怼",
            "抨击",
            "党争",
        ],
    )
}

fn contains_any(text: &str, words: &[&str]) -> bool {
    let lower = text.to_lowercase();
    words.iter().any(|word| lower.contains(&word.to_lowercase()))
}

fn news_summary(description: &str, source: Option<&str>) -> Option<String> {
    let cleaned = description
        .replace("查看更多相关新闻", "")
        .replace("更多新闻", "")
        .replace("点击查看", "");
    let fallback = source
        .map(|name| format!("来自{name}的最新动态，点开看完整信息。"))
        .unwrap_or_else(|| "最新动态已收录，点开看完整信息。".to_string());
    let source_text = clean_spaces(&cleaned);
    let summary_text = if source_text.trim().is_empty() {
        fallback.as_str()
    } else {
        source_text.trim()
    };
    let summary = compact_chars(summary_text, 30);
    if summary.is_empty() {
        None
    } else {
        Some(summary)
    }
}

fn clean_spaces(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn compact_chars(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    format!("{}...", chars[..max].iter().collect::<String>())
}

fn tag_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut blocks = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after_open = &rest[start + open.len()..];
        let Some(end) = after_open.find(&close) else {
            break;
        };
        blocks.push(&after_open[..end]);
        rest = &after_open[end + close.len()..];
    }
    blocks
}

fn tag_value<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}");
    let start = xml.find(&open)?;
    let after_open_start = &xml[start..];
    let tag_end = after_open_start.find('>')?;
    let after_open = &after_open_start[tag_end + 1..];
    let close = format!("</{tag}>");
    let end = after_open.find(&close)?;
    Some(&after_open[..end])
}

fn clean_xml_text(text: &str) -> String {
    clean_spaces(&strip_tags(&decode_xml_entities(
        strip_cdata(text).trim().to_string(),
    )))
}

fn strip_cdata(text: &str) -> &str {
    text.trim()
        .strip_prefix("<![CDATA[")
        .and_then(|s| s.strip_suffix("]]>"))
        .unwrap_or(text)
}

fn strip_tags(text: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn decode_xml_entities(text: String) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn clean_news_title(title: &str, source: Option<&str>) -> String {
    let title = title.trim();
    let Some(source) = source else {
        return title.to_string();
    };
    title
        .strip_suffix(&format!(" - {source}"))
        .unwrap_or(title)
        .trim()
        .to_string()
}

fn news_key(title: &str, link: &str) -> String {
    let title_key = title
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    if !title_key.is_empty() {
        return title_key;
    }
    link.trim().to_lowercase()
}

fn pick_unique_index(len: usize, excluded: &[usize]) -> Option<usize> {
    if len == 0 {
        return None;
    }
    let excluded: HashSet<usize> = excluded.iter().copied().collect();
    let start = ((now_ms() / 7_200_000).max(0) as usize) % len;
    (0..len)
        .map(|offset| (start + offset) % len)
        .find(|idx| !excluded.contains(idx))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const QUOTES: &[&str] = &[
    "先把最小的一步做掉，焦虑会少一格。",
    "今天不用惊艳，别掉线就已经很厉害。",
    "别和任务深情对视，先动手五分钟。",
    "温柔一点推进，也算推进。",
    "把问题拆小，是成年人合法开挂。",
    "不想做的时候，只做开头也算赢了一局。",
    "清醒不是硬撑，是知道哪里该省电。",
    "慢一点没事，别把自己交给混乱。",
    "做完再评价，别让脑内评委提前上班。",
    "今天也不用变成机器，做成一小块就够了。",
    "今天能做完的最小一步，也会改变明天的起点。",
    "清醒不是不疲惫，而是知道下一步该往哪里落。",
    "把复杂问题摊开，它就少了一半的威风。",
    "稳定的节奏，比偶尔的爆发更可靠。",
    "先完成，再修饰；先前进，再评判。",
    "每一次复盘，都是把经验从时间里捞回来。",
    "别急着证明自己，先把事情做成。",
    "真正可靠的进步，通常安静得不像胜利。",
    "把注意力放回手边，很多难题会先变小。",
    "计划不是束缚，是给行动留一条清楚的路。",
    "今天少一点犹豫，明天就少一点补救。",
    "做事的勇气，常常来自一个足够小的开始。",
    "不要等状态完美，状态会在行动里被调出来。",
    "复杂的时候，先把事实和猜测分开放。",
    "能被记录下来的混乱，已经开始被管理。",
    "一个清楚的问题，胜过十个模糊的焦虑。",
    "保持节奏，比保持兴奋更难，也更有用。",
    "把任务交给时间表，把判断留给完成之后。",
    "今天的秩序，是明天速度的来源。",
    "别让完美主义替拖延穿上体面的外衣。",
    "困难不是结论，只是需要拆解的材料。",
    "能持续的办法，往往比最聪明的办法更好。",
    "先把眼前一米走稳，远处自然会露出来。",
    "少一点同时开始，多一点真正结束。",
    "专注不是紧绷，而是持续回到当下。",
    "没有白费的整理，只有迟来的清晰。",
    "给下一步一个名字，行动就有了入口。",
    "把担心写下来，它就不再占用整张桌面。",
    "稳定地做普通事，也会堆出不普通的结果。",
    "好的复盘不是责备昨天，而是照亮明天。",
    "不确定时，先做能验证的一步。",
    "别和混乱争辩，动手分类。",
    "让结果说话，别让预感抢先宣判。",
    "行动的价值，有时只是让你获得新的信息。",
    "能按时停下，也是一种高级的自控。",
    "真正的效率，是少做无谓的切换。",
    "今天多保存一点上下文，明天少重新进入一次。",
    "别把所有问题都留给意志力，给环境也分点责任。",
    "安静推进，本身就很有力量。",
];

const TRIVIA: &[&str] = &[
    "浏览器地址栏输入关键词前加 site:，可以只搜索某个指定网站。",
    "多数路由器长时间不断电会积累缓存，偶尔重启能解决一些玄学卡顿。",
    "手机拍屏幕出现条纹，多半是屏幕刷新率和相机快门不同步。",
    "搜索报错信息时给完整错误加英文引号，通常能减少无关结果。",
    "冷水洗手后擦干，比自然风干更不容易让皮肤变干。",
    "文件名里写日期时用 2026-07-04 这种格式，排序会天然按时间排列。",
    "网页打不开时先试试无痕窗口，可以快速判断是不是缓存或插件的问题。",
    "很多 App 的“稍后提醒”会降低记忆负担，但太多会变成第二个待办池。",
    "输入法里建立常用短语，能把重复地址、邮箱、模板回复压成几个字母。",
    "微波炉加热面包旁边放一小杯水，口感通常没那么快变硬。",
    "人的大脑在休息时仍会整理记忆，所以短暂离屏有时能帮助解决卡住的问题。",
    "番茄工作法最初使用的是厨房番茄计时器，核心不是 25 分钟，而是明确开始和停止。",
    "多数待办拖延并不是因为太难，而是因为下一步不够具体。",
    "写下问题时，大脑会自动把模糊焦虑拆成可处理的线索。",
    "短清单比长清单更容易启动，因为它减少了选择成本。",
    "睡前复盘适合记录事实和下一步，不适合做重大的自我审判。",
    "把任务命名为动词开头，比如“整理桌面”，通常比名词“桌面”更容易行动。",
    "人类短时记忆容量有限，把中间结果写下来能显著降低思考负担。",
    "任务切换会带来注意力残留，所以频繁切换后会感觉明明忙了却没推进。",
    "把文件名写清楚，其实是在给未来的自己节省搜索时间。",
    "很多灵感来自重组已有材料，而不是凭空出现。",
    "白噪声对有些人有帮助，是因为它能遮住更突兀的环境变化。",
    "晨间更适合做需要主动性的事，夜间更适合整理和收尾。",
    "眼睛疲劳常常不是屏幕太亮，而是长时间不眨眼导致泪膜不稳定。",
    "把大任务拆成 15 分钟能完成的动作，会降低启动阻力。",
    "清空桌面并不总能提升效率，真正关键的是常用物品位置稳定。",
    "人在低血糖或缺水时，更容易把普通问题感受成压力。",
    "复述问题给别人听，即使没人回答，也能触发自我纠错。",
    "纸笔记录有时比电子记录更容易形成空间记忆。",
    "把待办写成“何时何地做什么”，完成概率通常会更高。",
    "短暂散步能增加视觉和身体输入，常常帮助大脑脱离卡住的路径。",
    "屏幕通知的伤害不只在打断，还在于恢复原任务需要额外时间。",
    "越临近睡觉，越适合列明天第一步，而不是扩展新计划。",
    "把任务分成“判断”和“执行”两类，会减少来回犹豫。",
    "重复检查消息会制造完成感，但通常不等于真正推进。",
    "保存一个工作现场，比只保存最终文件更容易恢复思路。",
    "很多所谓懒惰，其实是任务边界不清造成的大脑回避。",
    "把参考资料集中到一个入口，可以减少“我刚才看到哪了”的损耗。",
    "低优先级任务堆太多，会让高优先级任务也显得更难开始。",
    "固定的收尾仪式能让大脑更容易从工作状态退出。",
    "视觉环境越杂乱，越容易诱发无意识的任务切换。",
    "给任务设置停止条件，比只设置目标更能防止无限打磨。",
    "把错误单独记录下来，会让它从情绪事件变成可复用经验。",
    "同一条信息以文字和图像两种方式出现，更容易被记住。",
    "先列反例有时能更快发现方案的薄弱点。",
    "把“等一下再说”改成具体时间，是减少拖延的简单办法。",
    "长期效率依赖恢复质量，休息不是奖励，而是系统维护。",
    "用固定模板做复盘，可以减少每次开始复盘时的选择成本。",
    "把今天的最后一步留成明天的第一步，会更容易重新进入状态。",
];
