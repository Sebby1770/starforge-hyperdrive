#![no_std]

use core::panic::PanicInfo;

const WIDTH: usize = 320;
const HEIGHT: usize = 196;
const CHANNELS: usize = 4;
const BUFFER_LEN: usize = WIDTH * HEIGHT * CHANNELS;

static mut FRAMEBUFFER: [u8; BUFFER_LEN] = [0; BUFFER_LEN];
static mut POINTER_X: f32 = 0.0;
static mut POINTER_Y: f32 = 0.0;
static mut POINTER_DOWN: f32 = 0.0;
static mut MODE: u32 = 0;
static mut INTENSITY: f32 = 0.76;
static mut SEED: f32 = 13.37;
static mut FLUX: f32 = 0.0;

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
        POINTER_X = clamp(x, -2.0, 2.0);
        POINTER_Y = clamp(y, -2.0, 2.0);
        POINTER_DOWN = if down == 0 { 0.0 } else { 1.0 };
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn set_mode(mode: u32) {
    unsafe {
        MODE = mode % 4;
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn set_intensity(value: f32) {
    unsafe {
        INTENSITY = clamp(value, 0.15, 1.35);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn reseed(value: u32) {
    unsafe {
        let shifted = (value as f32 * 0.017_453_292) + 9.731;
        SEED = shifted + fract(libm::sinf(shifted) * 41_307.93);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn flux() -> f32 {
    unsafe { FLUX }
}

#[unsafe(no_mangle)]
pub extern "C" fn render(elapsed_ms: f32) {
    let time = elapsed_ms * 0.001;
    let (pointer_x, pointer_y, pointer_down, mode, intensity, seed) =
        unsafe { (POINTER_X, POINTER_Y, POINTER_DOWN, MODE, INTENSITY, SEED) };

    let aspect = WIDTH as f32 / HEIGHT as f32;
    let fb = core::ptr::addr_of_mut!(FRAMEBUFFER) as *mut u8;
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

            let warp_x = sx * (1.15 + 0.15 * libm::sinf(time + seed)) + pointer_x * pull * 0.18;
            let warp_y =
                sy * (1.05 + 0.12 * libm::cosf(time * 0.7 + seed)) + pointer_y * pull * 0.18;
            let noise = fbm(warp_x * 1.4 + time * 0.09, warp_y * 1.4 - time * 0.05, seed);

            let lane_wave = libm::sinf(
                sx * (4.6 + intensity * 1.4) + sy * 2.8 + radius * 3.4 - time * 1.7 + seed,
            );
            let lane = smoothstep(0.78, 1.0, libm::fabsf(lane_wave));

            let rings = 1.0
                - smoothstep(
                    0.0,
                    0.12,
                    libm::fabsf(fract(radius * (5.0 + intensity * 2.7) - time * 0.34) - 0.5),
                );

            let spark_hash = hash21(
                libm::floorf(warp_x * 44.0 + seed * 2.1),
                libm::floorf(warp_y * 44.0 - seed * 1.7),
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

            let (mut r, mut g, mut b) = palette(mode, color_phase + seed * 0.013);
            let vignette = smoothstep(1.62, 0.1, radius);
            let exposure = clamp(energy * intensity * (0.68 + vignette * 0.74), 0.0, 1.6);

            r = tonemap(r * exposure + spark * 0.8 + cursor_bloom * 0.28);
            g = tonemap(g * exposure + spark * 0.85 + cursor_bloom * 0.36);
            b = tonemap(b * exposure + spark * 1.0 + cursor_bloom * 0.46);

            flux_total += exposure;

            let idx = (y * WIDTH + x) * CHANNELS;
            unsafe {
                *fb.add(idx) = to_byte(r);
                *fb.add(idx + 1) = to_byte(g);
                *fb.add(idx + 2) = to_byte(b);
                *fb.add(idx + 3) = 255;
            }
        }
    }

    unsafe {
        FLUX = flux_total / (WIDTH * HEIGHT) as f32;
    }
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

fn fbm(mut x: f32, mut y: f32, seed: f32) -> f32 {
    let mut sum = 0.0;
    let mut amp = 0.55;
    let mut norm = 0.0;

    for octave in 0..3 {
        sum += noise2(x + seed * 0.11, y - seed * 0.07) * amp;
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
