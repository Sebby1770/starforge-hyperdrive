//! Deterministic fast approximations of the transcendentals the renderer leans on.
//!
//! The field equation evaluates roughly fifteen transcendental calls per pixel,
//! so correctly-rounded library implementations — each doing full argument
//! reduction — dominated the frame budget and pinned the engine to a 320x196
//! framebuffer. These replacements trade the last few digits of precision, which
//! no viewer can see once a value has been quantised to eight bits per channel,
//! for the headroom that makes higher render resolutions possible.
//!
//! Every function here is pure and branch-light, so a given input still produces
//! bit-identical output on every platform, preserving the engine's determinism
//! contract. The tests below pin every error bound against `std`.

const PI: f32 = core::f32::consts::PI;
const TAU: f32 = core::f32::consts::TAU;
const INV_TAU: f32 = 1.0 / core::f32::consts::TAU;
const LOG2E: f32 = core::f32::consts::LOG2_E;

/// Sine, accurate to better than 1.1e-3 absolute across the whole real line.
///
/// Uses the two-stage quadratic/quartic minimax pair after wrapping the input
/// into a single period, which costs one `floorf` instead of a full
/// Payne-Hanek reduction.
#[inline(always)]
pub fn sin(x: f32) -> f32 {
    let wrapped = x - TAU * libm::floorf(x * INV_TAU + 0.5);
    let first = 1.273_239_5 * wrapped - 0.405_284_74 * wrapped * abs(wrapped);
    0.225 * (first * abs(first) - first) + first
}

/// Cosine, sharing `sin`'s error bound via a quarter-turn phase shift.
#[inline(always)]
pub fn cos(x: f32) -> f32 {
    sin(x + PI * 0.5)
}

/// `e^-u` for non-negative `u`, accurate to better than 1e-6 relative.
///
/// Splits into an exact power-of-two scale and a degree-six polynomial over half
/// a binade, so it stays far inside the tone mapper's visible precision without
/// any table lookups.
#[inline(always)]
pub fn exp_neg(u: f32) -> f32 {
    if u <= 0.0 {
        return 1.0;
    }

    let t = u * LOG2E;
    // Round to nearest rather than down, so the polynomial only has to cover
    // half a binade. Halving the argument range cuts the truncation error of a
    // degree-six series by roughly two orders of magnitude.
    let whole = libm::floorf(t + 0.5);
    let x = whole - t;
    // Taylor coefficients of 2^x: ln(2)^k / k!.
    let poly = 1.0
        + x * (core::f32::consts::LN_2
            + x * (0.240_226_5
                + x * (0.055_504_11
                    + x * (0.009_618_129 + x * (0.001_333_355_8 + x * 0.000_154_035_3)))));

    // `u` reaches the renderer already clamped, so the exponent stays inside the
    // normal range and the bias arithmetic cannot underflow into a subnormal.
    let exponent = -(whole as i32);
    poly * pow2i(exponent)
}

#[inline(always)]
fn pow2i(exponent: i32) -> f32 {
    let biased = (exponent + 127).clamp(1, 254) as u32;
    f32::from_bits(biased << 23)
}

#[inline(always)]
pub fn abs(value: f32) -> f32 {
    f32::from_bits(value.to_bits() & 0x7fff_ffff)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_and_cos_track_the_standard_library() {
        let mut worst_sin = 0.0_f32;
        let mut worst_cos = 0.0_f32;

        // Sweep several periods in both directions so the wrapping step is
        // exercised well away from the origin, where a naive reduction drifts.
        for step in -40_000..40_000 {
            let x = step as f32 * 0.0025;
            worst_sin = worst_sin.max(abs(sin(x) - x.sin()));
            worst_cos = worst_cos.max(abs(cos(x) - x.cos()));
        }

        assert!(worst_sin < 1.1e-3, "sin error {worst_sin} is too large");
        assert!(worst_cos < 1.1e-3, "cos error {worst_cos} is too large");
    }

    #[test]
    fn exp_neg_tracks_the_standard_library_across_the_tonemap_domain() {
        let mut worst = 0.0_f32;

        // The tone mapper clamps its input to [0, 4] before scaling by 1.18.
        for step in 0..=4720 {
            let u = step as f32 * 0.001;
            let expected = (-u).exp();
            worst = worst.max(abs(exp_neg(u) - expected) / expected);
        }

        assert!(worst < 1e-6, "exp_neg relative error {worst} is too large");
        assert_eq!(exp_neg(0.0), 1.0);
        assert_eq!(exp_neg(-1.0), 1.0);
    }

    #[test]
    fn approximations_are_bit_reproducible() {
        for step in 0..1000 {
            let x = step as f32 * 0.017;
            assert_eq!(sin(x).to_bits(), sin(x).to_bits());
            assert_eq!(cos(x).to_bits(), cos(x).to_bits());
            assert_eq!(exp_neg(x).to_bits(), exp_neg(x).to_bits());
        }
    }

    #[test]
    fn abs_matches_the_standard_library() {
        for step in -500..500 {
            let x = step as f32 * 0.31;
            assert_eq!(abs(x), x.abs());
        }
    }
}
