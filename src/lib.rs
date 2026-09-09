#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
use core::panic::PanicInfo;

mod fastmath;

use fastmath::{abs, cos, exp_neg, sin};

/// Render resolutions are whole multiples of this tile so that every quality
/// tier keeps the instrument's 160:98 aspect ratio exactly. Sharing one aspect
/// across tiers means switching quality re-renders the same composition at more
/// detail rather than reframing it.
const TILE_WIDTH: usize = 160;
const TILE_HEIGHT: usize = 98;
pub const MIN_SCALE: u32 = 2;
pub const MAX_SCALE: u32 = 8;
const DEFAULT_SCALE: u32 = 2;

const MAX_WIDTH: usize = TILE_WIDTH * MAX_SCALE as usize;
const MAX_HEIGHT: usize = TILE_HEIGHT * MAX_SCALE as usize;
const CHANNELS: usize = 4;
const MAX_BUFFER_LEN: usize = MAX_WIDTH * MAX_HEIGHT * CHANNELS;

/// Number of distinct field equations and palettes the engine exposes.
const MODE_COUNT: u32 = 12;

#[derive(Clone, Copy, Debug, PartialEq)]
struct RenderState {
    pointer_x: f32,
    pointer_y: f32,
    pointer_down: f32,
    mode: u32,
    intensity: f32,
    hue: f32,
    seed: u32,
    width: usize,
    height: usize,
}

const DEFAULT_STATE: RenderState = RenderState {
    pointer_x: 0.0,
    pointer_y: 0.0,
    pointer_down: 0.0,
    mode: 0,
    intensity: 0.76,
    hue: 0.0,
    seed: 1337,
    width: TILE_WIDTH * DEFAULT_SCALE as usize,
    height: TILE_HEIGHT * DEFAULT_SCALE as usize,
};

/// Sized for `MAX_SCALE`, so `set_resolution` only ever hands the renderer a
/// prefix of a buffer that already exists. The array lives in `.bss`, which
/// costs nothing in the shipped module and removes any need for an allocator in
/// a `no_std` build.
static mut FRAMEBUFFER: [u8; MAX_BUFFER_LEN] = [0; MAX_BUFFER_LEN];
static mut STATE: RenderState = DEFAULT_STATE;
static mut FLUX: f32 = 0.0;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

#[unsafe(no_mangle)]
pub extern "C" fn width() -> u32 {
    unsafe { STATE.width as u32 }
}

#[unsafe(no_mangle)]
pub extern "C" fn height() -> u32 {
    unsafe { STATE.height as u32 }
}

#[unsafe(no_mangle)]
pub extern "C" fn max_width() -> u32 {
    MAX_WIDTH as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn max_height() -> u32 {
    MAX_HEIGHT as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn mode_count() -> u32 {
    MODE_COUNT
}

/// Select a render resolution of `scale` x (160 x 98).
///
/// Returns the scale actually applied, so the control surface can clamp its own
/// quality ladder to whatever this build supports rather than assuming a range.
#[unsafe(no_mangle)]
pub extern "C" fn set_resolution(scale: u32) -> u32 {
    let applied = scale.clamp(MIN_SCALE, MAX_SCALE);

    unsafe {
        STATE.width = TILE_WIDTH * applied as usize;
        STATE.height = TILE_HEIGHT * applied as usize;
    }

    applied
}

#[unsafe(no_mangle)]
pub extern "C" fn framebuffer_ptr() -> *const u8 {
    core::ptr::addr_of!(FRAMEBUFFER) as *const u8
}

#[unsafe(no_mangle)]
pub extern "C" fn set_pointer(x: f32, y: f32, down: u32) {
    unsafe {
        STATE.pointer_x = clamp(x, -2.0, 2.0);
        STATE.pointer_y = clamp(y, -2.0, 2.0);
        STATE.pointer_down = if down == 0 { 0.0 } else { 1.0 };
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn set_mode(mode: u32) {
    unsafe {
        STATE.mode = mode % MODE_COUNT;
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn set_intensity(value: f32) {
    unsafe {
        STATE.intensity = clamp(value, 0.15, 1.35);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn reseed(value: u32) {
    unsafe {
        STATE.seed = value;
    }
}

/// Rotate the palette. `0.0` is the native hue of the mode; `1.0` is a full turn.
#[unsafe(no_mangle)]
pub extern "C" fn set_hue(value: f32) {
    unsafe {
        STATE.hue = clamp(value, 0.0, 1.0);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn render(elapsed_ms: f32) {
    let state = unsafe { STATE };
    let len = state.width * state.height * CHANNELS;
    let framebuffer = unsafe {
        core::slice::from_raw_parts_mut(core::ptr::addr_of_mut!(FRAMEBUFFER) as *mut u8, len)
    };

    let flux = render_frame(framebuffer, elapsed_ms, state);

    unsafe {
        FLUX = flux;
    }
}

/// Mean per-pixel exposure of the most recent frame, in the range 0.0..=1.6.
///
/// The control surface reads this as live telemetry, so it is derived from the
/// same exposure term the renderer writes into the framebuffer rather than
/// being re-estimated on the JavaScript side.
#[unsafe(no_mangle)]
pub extern "C" fn flux() -> f32 {
    unsafe { FLUX }
}

/// Per-frame constants lifted out of the pixel loop.
///
/// Each of these used to be recomputed for every pixel even though none of them
/// depend on the pixel coordinate; hoisting them removes millions of redundant
/// transcendental calls per frame at the higher quality tiers.
struct FrameConstants {
    time: f32,
    warp_x_gain: f32,
    warp_y_gain: f32,
    spin_rate: f32,
    lane_gain: f32,
    ring_gain: f32,
    palette_offset: f32,
    seed_x: f32,
    seed_y: f32,
    spark_seed_x: f32,
    spark_seed_y: f32,
}

fn render_frame(framebuffer: &mut [u8], elapsed_ms: f32, state: RenderState) -> f32 {
    let RenderState {
        pointer_x,
        pointer_y,
        pointer_down,
        mode,
        intensity,
        hue,
        seed,
        width,
        height,
    } = state;

    let time = elapsed_ms * 0.001;
    let (seed_x, seed_y) = seed_components(seed);

    let constants = FrameConstants {
        time,
        warp_x_gain: 1.15 + 0.15 * sin(time + seed_x),
        warp_y_gain: 1.05 + 0.12 * cos(time * 0.7 + seed_y),
        spin_rate: time * (0.22 + intensity * 0.2),
        lane_gain: 4.6 + intensity * 1.4,
        ring_gain: 5.0 + intensity * 2.7,
        palette_offset: seed_x * 0.013 + seed_y * 0.009 + hue,
        seed_x,
        seed_y,
        spark_seed_x: seed_x * 2.1,
        spark_seed_y: seed_y * 1.7,
    };

    let aspect = width as f32 / height as f32;
    let inv_width = 1.0 / width as f32;
    let inv_height = 1.0 / height as f32;
    let mut flux_total = 0.0_f32;

    for y in 0..height {
        let ny = ((y as f32 * inv_height) - 0.5) * 2.0;
        let row = y * width * CHANNELS;

        for x in 0..width {
            let nx = ((x as f32 * inv_width) - 0.5) * 2.0 * aspect;
            let dx = nx - pointer_x;
            let dy = ny - pointer_y;
            let pointer_dist = libm::sqrtf(dx * dx + dy * dy);
            let pull = (0.08 + pointer_down * 0.42) / (pointer_dist + 0.16);

            let spin = constants.spin_rate + pointer_dist * (0.58 + pointer_down * 1.6);
            let cs = cos(spin + pull);
            let sn = sin(spin + pull);

            let sx = nx * cs - ny * sn;
            let sy = nx * sn + ny * cs;
            let radius = libm::sqrtf(sx * sx + sy * sy);

            let warp_x = sx * constants.warp_x_gain + pointer_x * pull * 0.18;
            let warp_y = sy * constants.warp_y_gain + pointer_y * pull * 0.18;
            let noise = fbm(
                warp_x * 1.4 + time * 0.09,
                warp_y * 1.4 - time * 0.05,
                constants.seed_x,
                constants.seed_y,
            );

            let lane_wave = sin(
                sx * constants.lane_gain + sy * 2.8 + radius * 3.4 - time * 1.7 + constants.seed_y,
            );
            let lane = smoothstep(0.78, 1.0, abs(lane_wave));

            let rings = 1.0
                - smoothstep(
                    0.0,
                    0.12,
                    abs(fract(radius * constants.ring_gain - time * 0.34) - 0.5),
                );

            let spark_hash = hash21(
                libm::floorf(warp_x * 44.0 + constants.spark_seed_x),
                libm::floorf(warp_y * 44.0 - constants.spark_seed_y),
            );
            let spark = smoothstep(0.974, 1.0, spark_hash)
                * smoothstep(0.25, 0.0, radius)
                * (0.65 + 0.35 * sin(time * 7.0 + spark_hash * 31.0));

            let core = smoothstep(1.08, 0.04, radius + noise * 0.16);
            let cursor_bloom = smoothstep(0.42, 0.0, pointer_dist) * (0.22 + pointer_down * 0.7);
            let energy = clamp(
                mode_energy(
                    mode,
                    &FieldSample {
                        noise,
                        lane,
                        rings,
                        core,
                        spark,
                        cursor_bloom,
                        radius,
                        sx,
                        sy,
                        ny,
                        pointer_dist,
                    },
                    &constants,
                ),
                0.0,
                1.65,
            );

            let color_phase = color_phase(mode, &constants, noise, radius, rings, sx, sy);

            let (mut r, mut g, mut b) = palette(mode, color_phase + constants.palette_offset);
            let vignette = smoothstep(1.62, 0.1, radius);
            let exposure = clamp(energy * intensity * (0.68 + vignette * 0.74), 0.0, 1.6);

            r = tonemap(r * exposure + spark * 0.8 + cursor_bloom * 0.28);
            g = tonemap(g * exposure + spark * 0.85 + cursor_bloom * 0.36);
            b = tonemap(b * exposure + spark * 1.0 + cursor_bloom * 0.46);

            flux_total += exposure;

            let idx = row + x * CHANNELS;
            framebuffer[idx] = to_byte(r);
            framebuffer[idx + 1] = to_byte(g);
            framebuffer[idx + 2] = to_byte(b);
            framebuffer[idx + 3] = 255;
        }
    }

    flux_total / (width * height) as f32
}

/// Per-pixel field terms shared by every mode mix.
///
/// Packed so `mode_energy` stays under Clippy's argument limit without
/// collapsing the per-mode equations into one giant function.
#[derive(Clone, Copy)]
struct FieldSample {
    noise: f32,
    lane: f32,
    rings: f32,
    core: f32,
    spark: f32,
    cursor_bloom: f32,
    radius: f32,
    sx: f32,
    sy: f32,
    ny: f32,
    pointer_dist: f32,
}

/// Mode-specific field mix. Shared geometry (noise, lanes, rings) is weighted
/// so each mode is a different instrument rather than a palette swap.
#[inline(always)]
fn mode_energy(mode: u32, sample: &FieldSample, constants: &FrameConstants) -> f32 {
    let time = constants.time;
    let pulse = 0.55 + 0.45 * sin(time * 6.2 + sample.radius * 4.0);
    let FieldSample {
        noise,
        lane,
        rings,
        core,
        spark,
        cursor_bloom,
        radius,
        sx,
        sy,
        ny,
        pointer_dist,
    } = *sample;

    match mode {
        // Aurora: original balanced mix.
        0 => noise * 0.74 + lane * 0.28 + rings * 0.18 + core * 0.58 + spark * 1.25 + cursor_bloom,
        // Solar: corona — core and rings, almost no lanes.
        1 => core * 1.15 + rings * 0.55 + spark * 0.85 + noise * 0.22 + cursor_bloom * 1.2,
        // Circuit: manhattan lanes, hard edges.
        2 => lane * 1.15 + noise * 0.35 + spark * 1.6 + core * 0.18 + cursor_bloom,
        // Tunnel: concentric rings dominate.
        3 => rings * 1.25 + core * 0.7 + noise * 0.2 + spark * 0.4 + cursor_bloom,
        // Nebula: soft fBm cloud, almost no structure.
        4 => noise * 1.22 + core * 0.28 + spark * 0.55 + cursor_bloom * 0.7,
        // Lattice: axis-aligned weave.
        5 => {
            let grid = (1.0 - smoothstep(0.0, 0.08, abs(fract(abs(sx) * 7.0) - 0.5)))
                * (1.0 - smoothstep(0.0, 0.08, abs(fract(abs(sy) * 7.0) - 0.5)));
            grid * 0.95 + noise * 0.4 + spark * 0.9 + cursor_bloom
        }
        // Prism: spectral split along radius.
        6 => radius * 0.55 + rings * 0.7 + noise * 0.35 + spark * 1.1 + cursor_bloom,
        // Vortex: angular arms.
        7 => {
            let arms = 1.0 - smoothstep(0.0, 0.18, abs(sin(libm::atan2f(sy, sx) * 3.0 + time)));
            arms * 0.9 + core * 0.45 + noise * 0.3 + spark * 0.7 + cursor_bloom
        }
        // Tide: horizontal swell.
        8 => {
            let swell = 0.5 + 0.5 * sin(ny * 9.0 + time * 1.4 + noise * 2.0);
            swell * 0.85 + noise * 0.4 + spark * 0.5 + cursor_bloom
        }
        // Pulsar: breathing core.
        9 => {
            core * pulse * 1.35
                + rings * (1.0 - pulse) * 0.8
                + spark * pulse
                + noise * 0.15
                + cursor_bloom
        }
        // Forge: ember sparks and heat.
        10 => spark * 2.1 + core * 0.7 + noise * 0.45 + lane * 0.12 + cursor_bloom * 0.8,
        // Eclipse: dark disk, bright rim.
        _ => {
            let rim = smoothstep(0.55, 0.72, radius) * smoothstep(1.05, 0.78, radius);
            rim * 1.4
                + (1.0 - core) * rings * 0.35
                + spark * 0.25
                + cursor_bloom * 1.4
                + smoothstep(0.2, 0.0, pointer_dist) * 0.3
        }
    }
}

#[inline(always)]
fn color_phase(
    mode: u32,
    constants: &FrameConstants,
    noise: f32,
    radius: f32,
    rings: f32,
    sx: f32,
    sy: f32,
) -> f32 {
    let time = constants.time;

    match mode {
        0 => noise * 0.72 + radius * 0.52 + time * 0.045,
        1 => radius * 0.76 - noise * 0.28 + time * 0.055,
        2 => (sx - sy) * 0.34 + noise * 0.64 + time * 0.037,
        3 => (sx + sy) * 0.34 + rings * 0.4 + time * 0.064,
        4 => noise * 1.18 - radius * 0.22 + time * 0.029,
        5 => abs(sx) * 0.62 + abs(sy) * 0.62 + noise * 0.3 + time * 0.041,
        6 => radius * 1.24 - rings * 0.36 + noise * 0.18 - time * 0.048,
        7 => (sx * sy) * 0.9 + noise * 0.44 + time * 0.072,
        8 => sy * 0.85 + noise * 0.4 + time * 0.05,
        9 => radius * 0.4 + time * 0.11 + noise * 0.2,
        10 => noise * 0.55 + spark_phase(sx, sy) + time * 0.06,
        _ => radius * 0.9 - noise * 0.5 + time * 0.033,
    }
}

#[inline(always)]
fn spark_phase(sx: f32, sy: f32) -> f32 {
    fract(abs(sx) * 3.1 + abs(sy) * 2.7)
}

fn palette(mode: u32, t: f32) -> (f32, f32, f32) {
    let wave = |offset: f32| 0.5 + 0.5 * cos(core::f32::consts::TAU * (t + offset));

    match mode {
        0 => (
            0.08 + 0.92 * wave(0.96),
            0.18 + 0.72 * wave(0.55),
            0.34 + 0.66 * wave(0.22),
        ),
        1 => (
            0.62 + 0.38 * wave(0.02),
            0.22 + 0.78 * wave(0.18),
            0.08 + 0.44 * wave(0.48),
        ),
        2 => (
            0.12 + 0.64 * wave(0.34),
            0.44 + 0.56 * wave(0.04),
            0.24 + 0.76 * wave(0.68),
        ),
        3 => (
            0.42 + 0.58 * wave(0.11),
            0.2 + 0.62 * wave(0.77),
            0.36 + 0.64 * wave(0.44),
        ),
        // Nebula: magenta and teal with a deep violet floor.
        4 => (
            0.28 + 0.62 * wave(0.86),
            0.1 + 0.5 * wave(0.31),
            0.44 + 0.56 * wave(0.63),
        ),
        // Lattice: cold green-on-steel, low red content.
        5 => (
            0.06 + 0.4 * wave(0.5),
            0.38 + 0.62 * wave(0.12),
            0.3 + 0.52 * wave(0.86),
        ),
        // Prism: broad full-spectrum sweep, evenly spaced phases.
        6 => (
            0.24 + 0.76 * wave(0.0),
            0.24 + 0.76 * wave(0.333),
            0.24 + 0.76 * wave(0.667),
        ),
        // Vortex: ember tones biased warm.
        7 => (
            0.5 + 0.5 * wave(0.07),
            0.16 + 0.56 * wave(0.42),
            0.05 + 0.35 * wave(0.71),
        ),
        // Tide: deep teal and foam.
        8 => (
            0.05 + 0.45 * wave(0.6),
            0.28 + 0.62 * wave(0.18),
            0.42 + 0.58 * wave(0.04),
        ),
        // Pulsar: ice-white with electric blue.
        9 => (
            0.55 + 0.45 * wave(0.0),
            0.6 + 0.4 * wave(0.12),
            0.85 + 0.15 * wave(0.55),
        ),
        // Forge: molten iron.
        10 => (
            0.72 + 0.28 * wave(0.05),
            0.18 + 0.42 * wave(0.22),
            0.04 + 0.18 * wave(0.7),
        ),
        // Eclipse: gold rim on a near-black floor.
        _ => (
            0.08 + 0.72 * wave(0.08),
            0.05 + 0.42 * wave(0.2),
            0.04 + 0.22 * wave(0.48),
        ),
    }
}

/// Rotation cosines and sines for each fBm octave.
///
/// `rot` only ever took the values `0.52 + octave * 0.17`, so these are compile
/// -time constants; they were previously recomputed with two trig calls per
/// octave per pixel.
const FBM_ROTATIONS: [(f32, f32); 3] = [
    (0.867_819_2, 0.496_880_14),
    (0.771_246, 0.636_537_2),
    (0.652_437_5, 0.757_842_6),
];

#[inline(always)]
fn fbm(mut x: f32, mut y: f32, seed_x: f32, seed_y: f32) -> f32 {
    let mut sum = 0.0;
    let mut amp = 0.55;
    let mut norm = 0.0;

    for (cs, sn) in FBM_ROTATIONS {
        sum += noise2(x + seed_x * 0.11, y - seed_y * 0.07) * amp;
        norm += amp;
        let nx = x * cs - y * sn;
        let ny = x * sn + y * cs;
        x = nx * 1.92 + 3.17;
        y = ny * 1.92 - 1.41;
        amp *= 0.48;
    }

    sum / norm
}

fn seed_components(seed: u32) -> (f32, f32) {
    // Each 16-bit half converts to f32 exactly. Independent integer avalanche
    // mixes then make neighbouring u32 seeds diverge without first collapsing
    // the full value into a lossy 24-bit f32 mantissa.
    let high = (seed >> 16) as f32 / 65_535.0;
    let low = (seed & 0xffff) as f32 / 65_535.0;
    let mixed_x = (mix_seed(seed ^ 0xa3c5_9ac3) & 0xffff) as f32 / 65_535.0;
    let mixed_y = (mix_seed(seed.rotate_left(16) ^ 0x3c6e_f372) & 0xffff) as f32 / 65_535.0;

    (
        0.25 + high * 7.0 + mixed_x * 29.0,
        0.5 + low * 11.0 + mixed_y * 31.0,
    )
}

fn mix_seed(mut value: u32) -> u32 {
    value ^= value >> 16;
    value = value.wrapping_mul(0x7feb_352d);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846c_a68b);
    value ^ (value >> 16)
}

#[inline(always)]
fn noise2(x: f32, y: f32) -> f32 {
    let ix = libm::floorf(x);
    let iy = libm::floorf(y);
    let fx = x - ix;
    let fy = y - iy;

    let ux = fx * fx * (3.0 - 2.0 * fx);
    let uy = fy * fy * (3.0 - 2.0 * fy);

    let a = hash21(ix, iy);
    let b = hash21(ix + 1.0, iy);
    let c = hash21(ix, iy + 1.0);
    let d = hash21(ix + 1.0, iy + 1.0);

    mix(mix(a, b, ux), mix(c, d, ux), uy)
}

#[inline(always)]
fn hash21(x: f32, y: f32) -> f32 {
    let p = fract(x * 0.1031 + y * 0.113_69);
    let q = p * (p + 33.33);
    fract((q + q) * (p + 19.19))
}

#[inline(always)]
fn fract(value: f32) -> f32 {
    value - libm::floorf(value)
}

#[inline(always)]
fn mix(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[inline(always)]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline(always)]
fn tonemap(value: f32) -> f32 {
    let x = clamp(value, 0.0, 4.0);
    1.0 - exp_neg(x * 1.18)
}

#[inline(always)]
fn to_byte(value: f32) -> u8 {
    (clamp(value, 0.0, 1.0) * 255.0) as u8
}

#[inline(always)]
fn clamp(value: f32, min: f32, max: f32) -> f32 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    /// Serialises the tests that drive the exported ABI.
    ///
    /// `STATE`, `FLUX`, and `FRAMEBUFFER` are process-wide statics, so the
    /// tests that exercise the real exports would otherwise race each other
    /// under the default parallel test runner. Tests calling only the pure
    /// `render_frame` helper need no guard.
    fn engine_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn buffer_len(state: RenderState) -> usize {
        state.width * state.height * CHANNELS
    }

    fn frame_for(state: RenderState, elapsed_ms: f32) -> Vec<u8> {
        let mut frame = vec![0; buffer_len(state)];
        render_frame(&mut frame, elapsed_ms, state);
        frame
    }

    fn flux_for(state: RenderState, elapsed_ms: f32) -> f32 {
        let mut frame = vec![0; buffer_len(state)];
        render_frame(&mut frame, elapsed_ms, state)
    }

    fn checksum(frame: &[u8]) -> u64 {
        frame.iter().enumerate().fold(0_u64, |sum, (index, value)| {
            sum.wrapping_add((*value as u64) * (index as u64 + 17))
        })
    }

    fn reset_state() {
        unsafe {
            STATE = DEFAULT_STATE;
        }
    }

    #[test]
    fn exported_dimensions_match_the_framebuffer_contract() {
        let _guard = engine_lock();
        reset_state();

        assert_eq!(width(), DEFAULT_STATE.width as u32);
        assert_eq!(height(), DEFAULT_STATE.height as u32);
        assert_eq!(max_width(), (TILE_WIDTH * MAX_SCALE as usize) as u32);
        assert_eq!(max_height(), (TILE_HEIGHT * MAX_SCALE as usize) as u32);
        assert_eq!(MAX_BUFFER_LEN, MAX_WIDTH * MAX_HEIGHT * CHANNELS);
        assert!(!framebuffer_ptr().is_null());
    }

    #[test]
    fn set_resolution_clamps_to_the_supported_scale_ladder() {
        let _guard = engine_lock();
        reset_state();

        for scale in MIN_SCALE..=MAX_SCALE {
            assert_eq!(set_resolution(scale), scale);
            assert_eq!(width(), (TILE_WIDTH * scale as usize) as u32);
            assert_eq!(height(), (TILE_HEIGHT * scale as usize) as u32);
            // Every tier must address memory the static framebuffer really has.
            assert!(width() as usize * height() as usize * CHANNELS <= MAX_BUFFER_LEN);
        }

        assert_eq!(set_resolution(0), MIN_SCALE);
        assert_eq!(width(), (TILE_WIDTH * MIN_SCALE as usize) as u32);
        assert_eq!(set_resolution(u32::MAX), MAX_SCALE);
        assert_eq!(width(), (TILE_WIDTH * MAX_SCALE as usize) as u32);

        reset_state();
    }

    #[test]
    fn every_tier_keeps_the_same_aspect_ratio() {
        let _guard = engine_lock();
        reset_state();
        let base = TILE_WIDTH as f32 / TILE_HEIGHT as f32;

        for scale in MIN_SCALE..=MAX_SCALE {
            set_resolution(scale);
            let ratio = width() as f32 / height() as f32;
            assert!(
                (ratio - base).abs() < 1e-6,
                "scale {scale} skewed the frame"
            );
        }

        reset_state();
    }

    #[test]
    fn render_never_writes_past_the_active_resolution() {
        let _guard = engine_lock();
        reset_state();

        // Poison the whole static, then render a small tier: anything the
        // renderer touches beyond its own frame shows up as a cleared sentinel.
        let buffer = unsafe {
            core::slice::from_raw_parts_mut(
                core::ptr::addr_of_mut!(FRAMEBUFFER) as *mut u8,
                MAX_BUFFER_LEN,
            )
        };
        buffer.fill(0xAB);

        set_resolution(3);
        set_intensity(0.9);
        render(1500.0);

        let active = width() as usize * height() as usize * CHANNELS;
        assert!(
            active < MAX_BUFFER_LEN,
            "the test tier must not be the largest"
        );
        assert!(
            buffer[..active]
                .chunks_exact(CHANNELS)
                .all(|px| px[3] == 255),
            "the active frame was left partly unwritten"
        );
        assert!(
            buffer[active..].iter().all(|byte| *byte == 0xAB),
            "the renderer wrote past the active resolution"
        );

        buffer.fill(0);
        reset_state();
    }

    #[test]
    fn public_state_setters_clamp_and_normalise_values() {
        let _guard = engine_lock();
        reset_state();

        set_pointer(9.0, -7.0, 42);
        set_mode(MODE_COUNT + 3);
        set_intensity(9.0);
        set_hue(4.0);
        reseed(u32::MAX);

        let upper_state = unsafe { STATE };
        assert_eq!(upper_state.pointer_x, 2.0);
        assert_eq!(upper_state.pointer_y, -2.0);
        assert_eq!(upper_state.pointer_down, 1.0);
        assert_eq!(upper_state.mode, 3);
        assert_eq!(upper_state.intensity, 1.35);
        assert_eq!(upper_state.hue, 1.0);
        assert_eq!(upper_state.seed, u32::MAX);

        set_pointer(-9.0, 7.0, 0);
        set_intensity(-4.0);
        set_hue(-1.0);
        let lower_state = unsafe { STATE };
        assert_eq!(lower_state.pointer_x, -2.0);
        assert_eq!(lower_state.pointer_y, 2.0);
        assert_eq!(lower_state.pointer_down, 0.0);
        assert_eq!(lower_state.intensity, 0.15);
        assert_eq!(lower_state.hue, 0.0);

        reset_state();
    }

    #[test]
    fn renderer_is_deterministic_nonblank_and_opaque() {
        let state = RenderState {
            pointer_x: 0.18,
            pointer_y: -0.24,
            pointer_down: 1.0,
            mode: 2,
            intensity: 0.94,
            seed: 1770,
            ..DEFAULT_STATE
        };
        let first = frame_for(state, 2400.0);
        let second = frame_for(state, 2400.0);

        assert_eq!(first, second);
        assert!(checksum(&first) > 0);
        assert!(first.chunks_exact(CHANNELS).all(|pixel| pixel[3] == 255));

        let dynamic_pixels = first
            .chunks_exact(CHANNELS)
            .filter(|pixel| pixel[0] != pixel[1] || pixel[1] != pixel[2])
            .count();
        assert!(dynamic_pixels > state.width * state.height / 2);
    }

    #[test]
    fn every_mode_renders_a_distinct_lit_frame() {
        let base = RenderState {
            seed: 31,
            ..DEFAULT_STATE
        };
        let mut checksums = Vec::new();

        for mode in 0..MODE_COUNT {
            let frame = frame_for(RenderState { mode, ..base }, 1800.0);

            assert!(
                frame.chunks_exact(CHANNELS).any(|px| px[..3] != [0, 0, 0]),
                "mode {mode} rendered a black frame"
            );
            checksums.push(checksum(&frame));
        }

        for (left, right) in
            (0..checksums.len()).flat_map(|i| ((i + 1)..checksums.len()).map(move |j| (i, j)))
        {
            assert_ne!(
                checksums[left], checksums[right],
                "modes {left} and {right} render identically"
            );
        }
    }

    #[test]
    fn modes_seeds_and_pointer_input_materially_change_the_frame() {
        let base = RenderState {
            seed: 31,
            ..DEFAULT_STATE
        };
        let base_frame = frame_for(base, 1800.0);
        let mode_frame = frame_for(RenderState { mode: 3, ..base }, 1800.0);
        let seed_frame = frame_for(RenderState { seed: 98, ..base }, 1800.0);
        let pointer_frame = frame_for(
            RenderState {
                pointer_x: 0.7,
                pointer_y: -0.4,
                pointer_down: 1.0,
                ..base
            },
            1800.0,
        );

        assert_ne!(checksum(&base_frame), checksum(&mode_frame));
        assert_ne!(checksum(&base_frame), checksum(&seed_frame));
        assert_ne!(checksum(&base_frame), checksum(&pointer_frame));
    }

    #[test]
    fn raising_the_tier_adds_detail_rather_than_reframing() {
        let low = RenderState {
            seed: 7788,
            width: TILE_WIDTH * 2,
            height: TILE_HEIGHT * 2,
            ..DEFAULT_STATE
        };
        let high = RenderState {
            width: TILE_WIDTH * 4,
            height: TILE_HEIGHT * 4,
            ..low
        };

        let low_frame = frame_for(low, 2000.0);
        let high_frame = frame_for(high, 2000.0);

        // Sampling the high tier back down to the low grid must land near the
        // low-tier frame: the composition is the same, only sharper.
        let mut matched = 0;
        let mut compared = 0;

        for y in 0..low.height {
            for x in 0..low.width {
                let low_idx = (y * low.width + x) * CHANNELS;
                let high_idx = ((y * 2) * high.width + x * 2) * CHANNELS;

                for channel in 0..3 {
                    let delta = (low_frame[low_idx + channel] as i32
                        - high_frame[high_idx + channel] as i32)
                        .abs();
                    compared += 1;
                    if delta <= 24 {
                        matched += 1;
                    }
                }
            }
        }

        let agreement = matched as f32 / compared as f32;
        assert!(
            agreement > 0.9,
            "tiers disagree on the composition ({agreement} matched)"
        );
    }

    #[test]
    fn adjacent_high_u32_seeds_remain_distinct() {
        let penultimate = RenderState {
            seed: u32::MAX - 1,
            ..DEFAULT_STATE
        };
        let ultimate = RenderState {
            seed: u32::MAX,
            ..DEFAULT_STATE
        };
        let penultimate_frame = frame_for(penultimate, 2400.0);
        let ultimate_frame = frame_for(ultimate, 2400.0);
        let changed_pixels = penultimate_frame
            .chunks_exact(CHANNELS)
            .zip(ultimate_frame.chunks_exact(CHANNELS))
            .filter(|(left, right)| left[..3] != right[..3])
            .count();

        assert_ne!(
            seed_components(penultimate.seed),
            seed_components(ultimate.seed)
        );
        assert_ne!(checksum(&penultimate_frame), checksum(&ultimate_frame));
        assert!(changed_pixels > penultimate.width * penultimate.height / 4);
    }

    #[test]
    fn palette_and_tonemap_stay_in_displayable_ranges() {
        for mode in 0..MODE_COUNT {
            for step in -20..=20 {
                let phase = step as f32 / 3.0;
                let (r, g, b) = palette(mode, phase);
                for channel in [r, g, b] {
                    assert!(
                        (0.0..=1.0).contains(&channel),
                        "mode {mode} produced {channel} outside the displayable range"
                    );
                    assert!((0.0..=1.0).contains(&tonemap(channel * 2.0)));
                }
            }
        }
    }

    #[test]
    fn flux_is_a_bounded_mean_exposure() {
        let flux = flux_for(DEFAULT_STATE, 1200.0);

        assert!(flux.is_finite(), "flux must be finite, got {flux}");
        assert!(
            (0.0..=1.6).contains(&flux),
            "flux must stay inside the exposure clamp, got {flux}"
        );
        assert!(flux > 0.0, "a lit frame must report non-zero flux");
    }

    #[test]
    fn hue_rotates_the_palette_without_blanking_the_frame() {
        let base = RenderState {
            seed: 44,
            ..DEFAULT_STATE
        };
        let shifted = RenderState { hue: 0.33, ..base };
        let a = frame_for(base, 1600.0);
        let b = frame_for(shifted, 1600.0);
        assert_ne!(checksum(&a), checksum(&b));
        assert!(b.chunks_exact(CHANNELS).any(|px| px[..3] != [0, 0, 0]));
    }

    #[test]
    fn flux_tracks_intensity() {
        let dim = flux_for(
            RenderState {
                intensity: 0.2,
                ..DEFAULT_STATE
            },
            900.0,
        );
        let bright = flux_for(
            RenderState {
                intensity: 1.3,
                ..DEFAULT_STATE
            },
            900.0,
        );

        assert!(
            bright > dim,
            "raising intensity must raise reported flux ({bright} !> {dim})"
        );
    }

    #[test]
    fn flux_is_comparable_across_resolution_tiers() {
        let low = flux_for(
            RenderState {
                width: TILE_WIDTH * 2,
                height: TILE_HEIGHT * 2,
                ..DEFAULT_STATE
            },
            1500.0,
        );
        let high = flux_for(
            RenderState {
                width: TILE_WIDTH * 6,
                height: TILE_HEIGHT * 6,
                ..DEFAULT_STATE
            },
            1500.0,
        );

        // Flux is a mean, so changing the sample count must not move the meter.
        assert!(
            abs(low - high) < 0.05,
            "flux drifted between tiers ({low} vs {high})"
        );
    }

    #[test]
    fn flux_export_reflects_the_last_rendered_frame() {
        let _guard = engine_lock();
        reset_state();
        set_intensity(0.2);
        render(900.0);
        let dim = flux();

        set_intensity(1.3);
        render(900.0);
        let bright = flux();

        assert!(dim > 0.0 && bright > 0.0);
        assert!(
            bright > dim,
            "the exported flux must follow engine state ({bright} !> {dim})"
        );

        reset_state();
    }
}
