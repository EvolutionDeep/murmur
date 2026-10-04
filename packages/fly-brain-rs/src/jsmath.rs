//! JavaScript-semantics numeric helpers.
//!
//! Everything the TypeScript reference does with `Math.*` or with int32/uint32 coercions is
//! reproduced here with the SAME bit-level result. Transcendentals are verbatim ports of what
//! V8 runs (v8math.rs); the platform libm behind `f64::ln` / `f64::exp` / `f64::cos` and the
//! `libm` crate are deliberately NOT used because neither is bit-identical to V8.

/// `Math.imul(a, b)` on the 32-bit patterns.
#[inline]
pub fn imul(a: u32, b: u32) -> u32 {
    a.wrapping_mul(b)
}

/// ECMAScript ToInt32 on a Number.
#[inline]
pub fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc();
    // modulo 2^32, then reinterpret
    let m = t.rem_euclid(4294967296.0);
    (m as u64 as u32) as i32
}

/// ECMAScript ToUint32 on a Number.
#[inline]
pub fn to_uint32(x: f64) -> u32 {
    to_int32(x) as u32
}

/// `Math.round(x)` — V8's exact algorithm (CodeStubAssembler::Float64Round):
/// `r = ceil(x); if (r - 0.5 <= x) r else r - 1`. Ties go toward +∞, and no `x + 0.5`
/// rounding artefact is introduced.
#[inline]
pub fn round(x: f64) -> f64 {
    let r = x.ceil();
    if r - 0.5 <= x {
        r
    } else {
        r - 1.0
    }
}

/// `Math.min(a, b)` — NaN-propagating, and (+0, -0) ordering as in JS.
#[inline]
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        // Math.min(0, -0) === -0
        return if a.is_sign_negative() { a } else { b };
    }
    if a < b {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)` — NaN-propagating, and (+0, -0) ordering as in JS.
#[inline]
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        // Math.max(0, -0) === +0
        return if a.is_sign_positive() { a } else { b };
    }
    if a > b {
        a
    } else {
        b
    }
}

/// `Math.sign(x)`.
#[inline]
pub fn sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x // ±0 or NaN pass through
    }
}

/// `Math.exp` — V8's fdlibm port (see v8math.rs).
#[inline]
pub fn exp(x: f64) -> f64 {
    crate::v8math::exp(x)
}

/// `Math.log` — V8's fdlibm port (see v8math.rs).
#[inline]
pub fn log(x: f64) -> f64 {
    crate::v8math::log(x)
}

/// `Math.cos` — V8's fdlibm port (see v8math.rs; Node's build does not use the glibc variant).
#[inline]
pub fn cos(x: f64) -> f64 {
    crate::v8math::cos(x)
}

/// `Math.sqrt` — IEEE-754 correctly rounded everywhere, so std is fine.
#[inline]
pub fn sqrt(x: f64) -> f64 {
    x.sqrt()
}

/// `Math.tanh` — V8's fdlibm port (see v8math.rs).
#[inline]
pub fn tanh(x: f64) -> f64 {
    crate::v8math::tanh(x)
}

/// `Number.prototype.toString()` for the values that appear in a genome (finite numbers with
/// decimal exponent in [-6, 20]). JS switches to exponent notation outside that range; the
/// genome fields (integers up to 4000, density in [0.0005, 0.2]) never reach it, and this
/// function panics rather than silently mis-format if they ever do.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return "0".into();
    }
    let ax = x.abs();
    // Rust's Display prints the shortest round-trip digits without exponent, which coincides with
    // JS Number::toString inside JS's plain-decimal window 1e-7 <= |x| < 1e21.
    assert!(
        (1e-7..1e21).contains(&ax),
        "number_to_string: {x} is outside the plain-decimal window JS uses; exponent form not implemented"
    );
    format!("{x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_matches_js() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(-0.5), -0.0);
        assert!(round(-0.5).is_sign_negative());
        assert_eq!(round(1.4999999999999998), 1.0);
    }

    #[test]
    fn to_int32_wraps() {
        assert_eq!(to_int32(4294967295.0), -1);
        assert_eq!(to_int32(4294967296.0), 0);
        assert_eq!(to_int32(-1.0), -1);
        assert_eq!(to_int32(2147483648.0), i32::MIN);
    }

    #[test]
    fn number_strings() {
        assert_eq!(number_to_string(0.023), "0.023");
        assert_eq!(number_to_string(193.0), "193");
        assert_eq!(number_to_string(0.0005), "0.0005");
        assert_eq!(number_to_string(4294967295.0), "4294967295");
    }
}
