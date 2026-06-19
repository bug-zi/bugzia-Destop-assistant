//! City weather via wttr.in (the `/weather` command).
//!
//! - GET `https://wttr.in/<city>?format=j1&lang=zh` (no API key, metric units).
//! - Parses the JSON into a compact Markdown summary (current + 3-day forecast).
//! - Stateless: does NOT touch `ChatState` and does NOT require an AI key —
//!   weather is a standalone lookup, not a conversation turn.

use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// wttr.in rejects requests without a User-Agent with 403 in some setups.
const USER_AGENT: &str = concat!("bugzia/", env!("CARGO_PKG_VERSION"), " (desktop assistant)");

/// Look up `city` on wttr.in and return a Markdown summary. The result is shown
/// in the result overlay as a one-shot assistant message (no context written).
#[tauri::command]
pub async fn weather(_app: AppHandle, city: String) -> Result<String, String> {
    let city = city.trim();
    if city.is_empty() {
        return Err("请提供城市名，例如：/weather 北京".to_string());
    }

    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client 构建失败: {e}"))?;

    // reqwest parses the URL with the `url` crate, which percent-encodes the
    // non-ASCII city name in the path automatically — so UTF-8 city names work
    // without a manual encoder or extra dependency.
    let url = format!("https://wttr.in/{}?format=j1&lang=zh", city);
    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("请求天气失败: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(200).collect();
        // wttr.in returns "unknown location" with a 200 + JSON error in some
        // cases, but a real 4xx/5xx is surfaced here.
        return Err(format!("天气查询失败 (HTTP {status}): {snippet}"));
    }

    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析天气数据失败: {e}"))?;

    // wttr.in signals an unknown/ambiguous location with a JSON `data.error`.
    if let Some(err) = v["data"]["error"].as_array().and_then(|a| a.first()) {
        if let Some(msg) = err["msg"].as_str() {
            return Err(format!("未找到该城市：{msg}"));
        }
    }

    Ok(format_weather(&v))
}

/// Build the Markdown summary from the parsed wttr.in JSON. Every field access
/// is tolerant (falls back to "--") so a partial/odd response still renders.
fn format_weather(v: &Value) -> String {
    let area_name = v["nearest_area"][0]["areaName"][0]["value"]
        .as_str()
        .unwrap_or("");
    let country = v["nearest_area"][0]["country"][0]["value"]
        .as_str()
        .unwrap_or("");

    let cur = &v["current_condition"][0];
    let temp_c = cur["temp_C"].as_str().unwrap_or("--");
    let feels = cur["FeelsLikeC"].as_str().unwrap_or("--");
    let humidity = cur["humidity"].as_str().unwrap_or("--");
    let wind = cur["windspeedKmph"].as_str().unwrap_or("--");
    // `lang=zh` populates `lang_zh`; fall back to the English `weatherDesc`.
    let desc = cur["lang_zh"][0]["value"]
        .as_str()
        .or_else(|| cur["weatherDesc"][0]["value"].as_str())
        .unwrap_or("未知");

    let header = if !area_name.is_empty() {
        if !country.is_empty() {
            format!("{area_name}（{country}） · {desc}")
        } else {
            format!("{area_name} · {desc}")
        }
    } else {
        desc.to_string()
    };

    // 3-day forecast table (wttr.in returns today + 2 days).
    let mut forecast = String::from("| 日期 | 最高 | 最低 |\n|---|---|---|\n");
    if let Some(days) = v["weather"].as_array() {
        for day in days.iter().take(3) {
            let date = day["date"].as_str().unwrap_or("");
            let max = day["maxtempC"].as_str().unwrap_or("--");
            let min = day["mintempC"].as_str().unwrap_or("--");
            forecast.push_str(&format!("| {date} | {max}°C | {min}°C |\n"));
        }
    }

    format!(
        "{header}\n\n当前 {temp_c}°C（体感 {feels}°C）\n湿度 {humidity}% · 风速 {wind}km/h\n\n未来三天\n{forecast}"
    )
}
