//! Desktop waveform visualizer — capture system audio via cpal WASAPI loopback,
//! reduce it to a single loudness level, and broadcast that level to the waveform
//! overlay window (~30 fps). The frontend draws sakura petals whose spawn density
//! tracks the level; silence leaves only a calm water line.
//!
//! Threading: the cpal `Stream` is NOT guaranteed `Send` across cpal versions, so
//! it is owned by a dedicated std::thread for its whole lifetime and never crosses
//! threads. The managed `WaveformState` therefore holds only `Send` atomics + the
//! thread's `JoinHandle` (which is `Send`). Stopping = set the shutdown flag -> the
//! thread falls out of its loop -> the stream is dropped on that thread -> capture
//! stops. Everything here is best-effort: if the audio subsystem can't be opened,
//! the overlay simply stays flat (no crash, no error to the UI).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use tauri::{AppHandle, Emitter, Manager};

/// Emit cadence to the frontend (ms). ~30 fps is smooth for petal spawning and
/// cheap on the IPC channel.
const EMIT_INTERVAL_MS: u64 = 33;
/// Audio RMS gain: typical music sits around 0.05-0.2 RMS, so we scale up before
/// clamping to 0..1. The frontend additionally multiplies by `sensitivity`.
const RMS_GAIN: f32 = 6.0;

/// Shared capture state. `level` (0..1000) is written by the audio callback and
/// read by the emit loop; `shutdown` stops the capture thread; `handle` joins it.
/// All fields are `Send + Sync`, so the whole struct can live in `tauri::State`.
#[derive(Default)]
pub struct WaveformState {
    level: Arc<AtomicU32>,
    shutdown: Arc<AtomicBool>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

/// Start loopback capture on the default output device. Idempotent: a no-op if a
/// capture thread is already running. Any audio-subsystem failure is logged and
/// swallowed (the overlay just stays flat).
pub fn start_capture(app: AppHandle) {
    let state = app.state::<WaveformState>();
    if state.handle.lock().unwrap().is_some() {
        return; // already capturing
    }
    state.shutdown.store(false, Ordering::SeqCst);

    let level = state.level.clone();
    let shutdown = state.shutdown.clone();
    let app_for_emit = app.clone();

    let handle = std::thread::Builder::new()
        .name("bugzia-waveform".into())
        .spawn(move || {
            // Build the stream ON THIS THREAD so it never has to be `Send`.
            let stream = match build_loopback_stream(level.clone()) {
                Some(s) => s,
                None => {
                    eprintln!("[waveform] could not open loopback stream; overlay stays flat");
                    return;
                }
            };
            if let Err(e) = stream.play() {
                eprintln!("[waveform] stream.play failed: {e}");
                return;
            }
            // Keep the stream alive + emit the latest level until shutdown.
            while !shutdown.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(EMIT_INTERVAL_MS));
                let raw = level.load(Ordering::Relaxed) as f32 / 1000.0;
                let _ = app_for_emit.emit("waveform://level", raw.clamp(0.0, 1.0));
            }
            // `stream` dropped here on its owning thread -> capture stops.
        })
        .expect("spawn waveform capture thread");

    *state.handle.lock().unwrap() = Some(handle);
}

/// Stop the capture thread (which drops the stream). Idempotent.
pub fn stop_capture(app: &AppHandle) {
    let state = app.state::<WaveformState>();
    state.shutdown.store(true, Ordering::SeqCst);
    if let Some(h) = state.handle.lock().unwrap().take() {
        let _ = h.join();
    }
    state.level.store(0, Ordering::Relaxed);
}

/// Open a WASAPI loopback input stream on the DEFAULT OUTPUT device. cpal's WASAPI
/// backend opens a render endpoint in loopback mode when you build an input stream
/// on it, handing back whatever the speakers are playing. Branches on sample
/// format (shared-mode is usually f32) so any common format works.
fn build_loopback_stream(level: Arc<AtomicU32>) -> Option<cpal::Stream> {
    let host = cpal::default_host();
    let device = host.default_output_device()?;
    let supported = device.default_output_config().ok()?;
    // Read the format BEFORE `supported.into()` consumes it.
    let sample_format = supported.sample_format();
    let stream_config: cpal::StreamConfig = supported.into();
    let err_fn = |err| eprintln!("[waveform] stream error: {err}");

    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    level.store(rms_level(data, |s| *s), Ordering::Relaxed);
                },
                err_fn,
                None,
            )
            .ok()?,
        SampleFormat::I16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    level.store(rms_level(data, |s| *s as f32 / 32768.0), Ordering::Relaxed);
                },
                err_fn,
                None,
            )
            .ok()?,
        SampleFormat::U16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    // u16 is unsigned, centered at 32768.
                    level.store(
                        rms_level(data, |s| (*s as f32 - 32768.0) / 32768.0),
                        Ordering::Relaxed,
                    );
                },
                err_fn,
                None,
            )
            .ok()?,
        other => {
            eprintln!("[waveform] unsupported sample format {other:?}; overlay stays flat");
            return None;
        }
    };
    Some(stream)
}

/// RMS loudness of a buffer mapped to 0..1000. Takes a per-sample -> f32
/// converter so any integer/float sample format is handled with no allocation
/// on the audio thread (cpal 0.15's `Sample` trait lacks a direct `to_f32`).
fn rms_level<S>(samples: &[S], to_f32: impl Fn(&S) -> f32) -> u32 {
    if samples.is_empty() {
        return 0;
    }
    let sum_sq: f32 = samples.iter().map(|s| to_f32(s).powi(2)).sum();
    let rms = (sum_sq / samples.len() as f32).sqrt();
    let mapped = (rms * RMS_GAIN).clamp(0.0, 1.0);
    (mapped * 1000.0).round() as u32
}

// ---------------------------------------------------------------------------
// Commands (mirror the lyrics lifecycle commands)
// ---------------------------------------------------------------------------

/// Start or stop audio capture. The overlay window itself is created/hidden from
/// the frontend (ACL); this only drives the capture thread. Mirrors `lyrics_set_enabled`.
#[tauri::command]
pub fn waveform_set_enabled(app: AppHandle, enabled: bool) {
    if enabled {
        start_capture(app);
    } else {
        stop_capture(&app);
    }
}

/// Lock = click-through. Implemented in Rust (not the frontend) because the
/// waveform window's capability lacks `allow-set-ignore-cursor-events`; a backend
/// command has full window access regardless of the caller's ACL.
#[tauri::command]
pub fn waveform_set_locked(app: AppHandle, locked: bool) -> Result<(), String> {
    let w = app
        .get_webview_window("waveform")
        .ok_or("waveform window not found")?;
    w.set_ignore_cursor_events(locked)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("waveform://lock-changed", locked);
    Ok(())
}

/// Pin (or unpin) the overlay above every other window. Same ACL rationale as
/// `waveform_set_locked`.
#[tauri::command]
pub fn waveform_set_always_on_top(app: AppHandle, top: bool) -> Result<(), String> {
    let w = app
        .get_webview_window("waveform")
        .ok_or("waveform window not found")?;
    w.set_always_on_top(top).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests (pure functions only — cpal capture is hardware-bound)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rms_silence_is_zero() {
        assert_eq!(rms_level(&[0.0f32; 1024], |s| *s), 0);
    }

    #[test]
    fn rms_full_scale_saturates() {
        // +/-1.0 square -> RMS 1.0 -> *gain -> clamp 1.0 -> 1000.
        let samples: Vec<f32> = (0..1024)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        assert_eq!(rms_level(&samples, |s| *s), 1000);
    }

    #[test]
    fn rms_empty_is_zero() {
        assert_eq!(rms_level::<f32>(&[], |s| *s), 0);
    }

    #[test]
    fn rms_int_formats_match_float() {
        // i16 max-amplitude samples convert to ~+/-1.0, matching the f32 square.
        let i: Vec<i16> = (0..1024)
            .map(|i| if i % 2 == 0 { i16::MAX } else { i16::MIN })
            .collect();
        let f: Vec<f32> = (0..1024)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        assert_eq!(
            rms_level(&i, |s| *s as f32 / 32768.0),
            rms_level(&f, |s| *s)
        );
    }
}
