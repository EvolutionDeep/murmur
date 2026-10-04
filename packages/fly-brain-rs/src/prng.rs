//! The reference's PRNGs, on u32 wrapping arithmetic (= JS int32/uint32 coercions).
//!
//! connectome.ts and genome.ts each carry their own copy of mulberry32. They are written with
//! different coercion spellings (`| 0` vs `>>> 0`) but compute the identical sequence, since every
//! JS int32/uint32 coercion is just a reinterpretation of the same 32-bit pattern and `Math.imul`
//! is a wrapping multiply. One implementation serves both (tests/parity.rs checks both traces).

/// mulberry32: `a += 0x6d2b79f5; t = imul(a ^ (a >>> 15), a | 1);
/// t ^= t + imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2^32`.
#[derive(Clone, Debug)]
pub struct Mulberry32 {
    a: u32,
}

impl Mulberry32 {
    #[inline]
    pub fn new(seed: u32) -> Self {
        Self { a: seed }
    }

    /// Next raw uint32 output (before the `/ 4294967296` scaling).
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }

    /// Next value in [0, 1): `u32 / 4294967296` (exact in f64).
    #[inline]
    pub fn next(&mut self) -> f64 {
        self.next_u32() as f64 / 4294967296.0
    }
}

/// FlyBrain's private xorshift32 spontaneous-noise source:
/// `x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2^32`.
#[derive(Clone, Debug)]
pub struct XorShift32 {
    pub state: u32,
}

impl XorShift32 {
    #[inline]
    pub fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    #[inline]
    pub fn next(&mut self) -> f64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.state = x;
        x as f64 / 4294967296.0
    }
}
