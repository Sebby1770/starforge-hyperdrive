#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
use core::panic::PanicInfo;

const WIDTH: usize = 320;
const HEIGHT: usize = 196;
const CHANNELS: usize = 4;
const BUFFER_LEN: usize = WIDTH * HEIGHT * CHANNELS;

#[derive(Clone, Copy, Debug, PartialEq)]
struct RenderState {
    pointer_x: f32,
    pointer_y: f32,
    pointer_down: f32,
    mode: u32,
    intensity: f32,
    seed: u32,
}

const DEFAULT_STATE: RenderState = RenderState {
    pointer_x: 0.0,
    pointer_y: 0.0,
    pointer_down: 0.0,
    mode: 0,
    intensity: 0.76,
    seed: 1337,
};

static mut FRAMEBUFFER: [u8; BUFFER_LEN] = [0; BUFFER_LEN];
static mut STATE: RenderState = DEFAULT_STATE;
static mut FLUX: f32 = 0.0;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

#[unsafe(no_mangle)]
pub extern "C" fn width() -> u32 {
    WIDTH as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn height() -> u32 {
    HEIGHT as u32
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
        STATE.mode = mode % 4;
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

#[unsafe(no_mangle)]
pub extern "C" fn render(elapsed_ms: f32) {
    let state = unsafe { STATE };
    let framebuffer = unsafe {
        core::slice::from_raw_parts_mut(core::ptr::addr_of_mut!(FRAMEBUFFER) as *mut u8, BUFFER_LEN)
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

fn render_frame(framebuffer: &mut [u8], elapsed_ms: f32, state: RenderState) -> f32 {
    let time = elapsed_ms * 0.001;
    let RenderState {
        pointer_x,
        pointer_y,
        pointer_down,
        mode,
        intensity,
        seed,
    } = state;
    let (seed_x, seed_y) = seed_components(seed);

    let aspect = WIDTH as f32 / HEIGHT as f32;
    let mut flux_total = 0.0_f32;

    for y in 0..HEIGHT {
        let ny = ((y as f32 / HEIGHT as f32) - 0.5) * 2.0;

        for x in 0..WIDTH {
            let nx = ((x as f32 / WIDTH as f32) - 0.5) * 2.0 * aspect;
            let dx = nx - pointer_x;
            let dy = ny - pointer_y;
            let pointer_dist = libm::sqrtf(dx * dx + dy * dy);
            let pull = (0.08 + pointer_down * 0.42) / (pointer_dist + 0.16);

            let spin = time * (0.22 + intensity * 0.2) + pointer_dist * (0.58 + pointer_down * 1.6);
            let cs = libm::cosf(spin + pull);
            let sn = libm::sinf(spin + pull);

            let sx = nx * cs - ny * sn;
            let sy = nx * sn + ny * cs;
            let radius = libm::sqrtf(sx * sx + sy * sy);

            let warp_x = sx * (1.15 + 0.15 * libm::sinf(time + seed_x)) + pointer_x * pull * 0.18;
            let warp_y =
                sy * (1.05 + 0.12 * libm::cosf(time * 0.7 + seed_y)) + pointer_y * pull * 0.18;
            let noise = fbm(
                warp_x * 1.4 + time * 0.09,
                warp_y * 1.4 - time * 0.05,
                seed_x,
                seed_y,
            );

            let lane_wave = libm::sinf(
                sx * (4.6 + intensity * 1.4) + sy * 2.8 + radius * 3.4 - time * 1.7 + seed_y,
            );
            let lane = smoothstep(0.78, 1.0, libm::fabsf(lane_wave));

            let rings = 1.0
                - smoothstep(
                    0.0,
                    0.12,
                    libm::fabsf(fract(radius * (5.0 + intensity * 2.7) - time * 0.34) - 0.5),
                );

            let spark_hash = hash21(
                libm::floorf(warp_x * 44.0 + seed_x * 2.1),
                libm::floorf(warp_y * 44.0 - seed_y * 1.7),
            );
            let spark = smoothstep(0.974, 1.0, spark_hash)
                * smoothstep(0.25, 0.0, radius)
                * (0.65 + 0.35 * libm::sinf(time * 7.0 + spark_hash * 31.0));

            let core = smoothstep(1.08, 0.04, radius + noise * 0.16);
            let cursor_bloom = smoothstep(0.42, 0.0, pointer_dist) * (0.22 + pointer_down * 0.7);
            let energy = clamp(
                noise * 0.74
                    + lane * 0.28
                    + rings * 0.18
                    + core * 0.58
                    + spark * 1.25
                    + cursor_bloom,
                0.0,
                1.65,
            );

            let color_phase = match mode {
                0 => noise * 0.72 + radius * 0.52 + time * 0.045,
                1 => radius * 0.76 - noise * 0.28 + time * 0.055,
                2 => (sx - sy) * 0.34 + noise * 0.64 + time * 0.037,
                _ => (sx + sy) * 0.34 + rings * 0.4 + time * 0.064,
            };

            let (mut r, mut g, mut b) =
                palette(mode, color_phase + seed_x * 0.013 + seed_y * 0.009);
            let vignette = smoothstep(1.62, 0.1, radius);
            let exposure = clamp(energy * intensity * (0.68 + vignette * 0.74), 0.0, 1.6);

            r = tonemap(r * exposure + spark * 0.8 + cursor_bloom * 0.28);
            g = tonemap(g * exposure + spark * 0.85 + cursor_bloom * 0.36);
            b = tonemap(b * exposure + spark * 1.0 + cursor_bloom * 0.46);

            flux_total += exposure;

            let idx = (y * WIDTH + x) * CHANNELS;
            framebuffer[idx] = to_byte(r);
            framebuffer[idx + 1] = to_byte(g);
            framebuffer[idx + 2] = to_byte(b);
            framebuffer[idx + 3] = 255;
        }
    }

    flux_total / (WIDTH * HEIGHT) as f32
}

fn palette(mode: u32, t: f32) -> (f32, f32, f32) {
    let wave = |offset: f32| 0.5 + 0.5 * libm::cosf(6.283_185_5 * (t + offset));

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
        _ => (
            0.42 + 0.58 * wave(0.11),
            0.2 + 0.62 * wave(0.77),
            0.36 + 0.64 * wave(0.44),
        ),
    }
}

fn fbm(mut x: f32, mut y: f32, seed_x: f32, seed_y: f32) -> f32 {
    let mut sum = 0.0;
    let mut amp = 0.55;
    let mut norm = 0.0;

    for octave in 0..3 {
        sum += noise2(x + seed_x * 0.11, y - seed_y * 0.07) * amp;
        norm += amp;
        let rot = 0.52 + octave as f32 * 0.17;
        let cs = libm::cosf(rot);
        let sn = libm::sinf(rot);
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

fn noise2(x: f32, y: f32) -> f32 {
    let ix = libm::floorf(x);
    let iy = libm::floorf(y);
    let fx = fract(x);
    let fy = fract(y);

    let ux = fx * fx * (3.0 - 2.0 * fx);
    let uy = fy * fy * (3.0 - 2.0 * fy);

    let a = hash21(ix, iy);
    let b = hash21(ix + 1.0, iy);
    let c = hash21(ix, iy + 1.0);
    let d = hash21(ix + 1.0, iy + 1.0);

    mix(mix(a, b, ux), mix(c, d, ux), uy)
}

fn hash21(x: f32, y: f32) -> f32 {
    let p = fract(x * 0.1031 + y * 0.113_69);
    let q = p * (p + 33.33);
    fract((q + q) * (p + 19.19))
}

fn fract(value: f32) -> f32 {
    value - libm::floorf(value)
}

fn mix(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn tonemap(value: f32) -> f32 {
    let x = clamp(value, 0.0, 4.0);
    1.0 - libm::expf(-x * 1.18)
}

fn to_byte(value: f32) -> u8 {
    (clamp(value, 0.0, 1.0) * 255.0) as u8
}

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

    fn frame_for(state: RenderState, elapsed_ms: f32) -> Vec<u8> {
        let mut frame = vec![0; BUFFER_LEN];
        render_frame(&mut frame, elapsed_ms, state);
        frame
    }

    fn flux_for(state: RenderState, elapsed_ms: f32) -> f32 {
        let mut frame = vec![0; BUFFER_LEN];
        render_frame(&mut frame, elapsed_ms, state)
    }

    fn checksum(frame: &[u8]) -> u64 {
        frame.iter().enumerate().fold(0_u64, |sum, (index, value)| {
            sum.wrapping_add((*value as u64) * (index as u64 + 17))
        })
    }

    #[test]
    fn exported_dimensions_match_the_framebuffer_contract() {
        assert_eq!(width(), WIDTH as u32);
        assert_eq!(height(), HEIGHT as u32);
        assert_eq!(BUFFER_LEN, 320 * 196 * 4);
        assert!(!framebuffer_ptr().is_null());
    }

    #[test]
    fn public_state_setters_clamp_and_normalise_values() {
        unsafe {
            STATE = DEFAULT_STATE;
        }

        set_pointer(9.0, -7.0, 42);
        set_mode(11);
        set_intensity(9.0);
        reseed(u32::MAX);

        let upper_state = unsafe { STATE };
        assert_eq!(upper_state.pointer_x, 2.0);
        assert_eq!(upper_state.pointer_y, -2.0);
        assert_eq!(upper_state.pointer_down, 1.0);
        assert_eq!(upper_state.mode, 3);
        assert_eq!(upper_state.intensity, 1.35);
        assert_eq!(upper_state.seed, u32::MAX);

        set_pointer(-9.0, 7.0, 0);
        set_intensity(-4.0);
        let lower_state = unsafe { STATE };
        assert_eq!(lower_state.pointer_x, -2.0);
        assert_eq!(lower_state.pointer_y, 2.0);
        assert_eq!(lower_state.pointer_down, 0.0);
        assert_eq!(lower_state.intensity, 0.15);
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
        assert!(dynamic_pixels > WIDTH * HEIGHT / 2);
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
        assert!(changed_pixels > WIDTH * HEIGHT / 4);
    }

    #[test]
    fn palette_and_tonemap_stay_in_displayable_ranges() {
        for mode in 0..4 {
            for step in -20..=20 {
                let phase = step as f32 / 3.0;
                let (r, g, b) = palette(mode, phase);
                for channel in [r, g, b] {
                    assert!((0.0..=1.0).contains(&channel));
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
    fn flux_export_reflects_the_last_rendered_frame() {
        unsafe {
            STATE = DEFAULT_STATE;
        }
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
    }
}
