/**
 * AssemblyScript's integer types, declared for the plain-TypeScript build.
 *
 * `assembly/mesher.ts` is compiled twice: by `asc` into WebAssembly, and by
 * `tsc` into JavaScript for the fallback path. asc provides these types
 * natively and never sees this file (it only compiles the entry module and its
 * imports); tsc includes it so the same annotations typecheck there too.
 */
declare type i8 = number;
declare type u8 = number;
declare type i16 = number;
declare type u16 = number;
declare type i32 = number;
declare type u32 = number;
declare type i64 = number;
declare type u64 = number;
declare type f32 = number;
declare type f64 = number;
declare type isize = number;
declare type usize = number;
declare type bool = boolean;
