//! Typst compiled for the browser.
//!
//! The JavaScript host owns the file contents and the fonts; this crate owns
//! the compiler state. A single [`TypstEngine`] is created once per worker and
//! lives for the whole session so that `comemo`'s incremental cache survives
//! across keystrokes.

pub mod engine;
pub mod packages;
pub mod world;

pub use engine::{
    Completion, Completions, Diagnostic, Engine, Hover, PdfOutput, SvgOutput, Token,
    STARTER_DOCUMENT, STARTER_PATH,
};

#[cfg(target_arch = "wasm32")]
mod bindings {
    use wasm_bindgen::prelude::*;

    use crate::engine::Engine;
    use typst::foundations::Bytes;

    /// The compiler, as seen from JavaScript.
    #[wasm_bindgen]
    pub struct TypstEngine {
        inner: Engine,
    }

    #[wasm_bindgen]
    impl TypstEngine {
        /// Creates an engine. `local_now_ms` is `Date.now()` shifted by the
        /// viewer's time-zone offset, because wasm has no clock of its own.
        #[wasm_bindgen(constructor)]
        pub fn new(local_now_ms: f64) -> Self {
            console_error_panic_hook::set_once();
            let mut inner = Engine::new();
            inner.world_mut().set_today(local_now_ms);
            Self { inner }
        }

        /// Registers every face in a font file. Call before the first compile.
        #[wasm_bindgen(js_name = addFont)]
        pub fn add_font(&mut self, data: &[u8]) {
            self.inner.world_mut().add_font(Bytes::new(data.to_vec()));
        }

        /// The number of registered font faces.
        #[wasm_bindgen(js_name = fontCount)]
        pub fn font_count(&self) -> usize {
            self.inner.world().font_count()
        }

        /// Writes a text file into the virtual file system.
        #[wasm_bindgen(js_name = setSource)]
        pub fn set_source(&mut self, path: &str, text: &str) {
            self.inner.world_mut().set_source(path, text);
        }

        /// Writes a binary file (an image, a data file) into the virtual file
        /// system.
        #[wasm_bindgen(js_name = setBinary)]
        pub fn set_binary(&mut self, path: &str, data: &[u8]) {
            self.inner
                .world_mut()
                .set_binary(path, Bytes::new(data.to_vec()));
        }

        #[wasm_bindgen(js_name = removeFile)]
        pub fn remove_file(&mut self, path: &str) {
            self.inner.world_mut().remove_file(path);
        }

        /// Writes one file of a package, e.g. `"@preview/cetz:0.3.1"` with
        /// path `"/lib.typ"`.
        ///
        /// Returns an error for a spec Typst cannot parse rather than
        /// silently dropping the file.
        #[wasm_bindgen(js_name = addPackageFile)]
        pub fn add_package_file(
            &mut self,
            spec: &str,
            path: &str,
            data: &[u8],
        ) -> Result<(), JsValue> {
            let spec = parse_spec(spec)?;
            self.inner.world_mut().add_package_file(&spec, path, data);
            Ok(())
        }

        /// Marks a package as completely written, after its last file.
        #[wasm_bindgen(js_name = markPackageLoaded)]
        pub fn mark_package_loaded(&mut self, spec: &str) -> Result<(), JsValue> {
            let spec = parse_spec(spec)?;
            self.inner.world_mut().mark_package_loaded(spec);
            Ok(())
        }

        /// Package specs referenced by loaded sources but not yet present.
        #[wasm_bindgen(js_name = missingPackages)]
        pub fn missing_packages(&self) -> Result<JsValue, JsValue> {
            to_js(&self.inner.missing_packages())
        }

        #[wasm_bindgen(js_name = setMain)]
        pub fn set_main(&mut self, path: &str) {
            self.inner.world_mut().set_main(path);
        }

        #[wasm_bindgen(js_name = setToday)]
        pub fn set_today(&mut self, local_now_ms: f64) {
            self.inner.world_mut().set_today(local_now_ms);
        }

        /// Compiles to one SVG string per page.
        ///
        /// Returns `{ pages: string[], diagnostics: Diagnostic[] }`.
        #[wasm_bindgen(js_name = compileSvg)]
        pub fn compile_svg(&mut self) -> Result<JsValue, JsValue> {
            to_js(&self.inner.compile_svg())
        }

        /// Compiles to a PDF.
        ///
        /// Returns `{ data: Uint8Array | null, diagnostics: Diagnostic[] }`.
        #[cfg(feature = "pdf")]
        #[wasm_bindgen(js_name = compilePdf)]
        pub fn compile_pdf(&self) -> Result<JsValue, JsValue> {
            to_js(&self.inner.compile_pdf())
        }

        /// Completions at a byte offset in a file.
        #[wasm_bindgen]
        pub fn autocomplete(
            &self,
            path: &str,
            cursor: usize,
            explicit: bool,
        ) -> Result<JsValue, JsValue> {
            to_js(&self.inner.autocomplete(path, cursor, explicit))
        }

        /// Documentation for whatever is at a byte offset, or `null`.
        #[wasm_bindgen]
        pub fn hover(&self, path: &str, cursor: usize) -> Result<JsValue, JsValue> {
            to_js(&self.inner.hover(path, cursor))
        }

        /// Syntax-highlighting tokens for a source file.
        #[wasm_bindgen]
        pub fn highlight(&self, path: &str) -> Result<JsValue, JsValue> {
            to_js(&self.inner.highlight(path))
        }

        /// Drops memoized results older than `max_age` compilations.
        #[wasm_bindgen]
        pub fn evict(&self, max_age: usize) {
            self.inner.evict(max_age);
        }

        /// Formats a Typst source text (typstyle). Fails on a syntax error.
        #[wasm_bindgen]
        pub fn format(&self, text: &str, max_width: usize, tab_spaces: usize) -> Result<String, JsValue> {
            self.inner
                .format(text, max_width, tab_spaces)
                .map_err(|err| JsValue::from_str(&err))
        }
    }

    /// The document a fresh session starts from.
    #[wasm_bindgen(js_name = starterDocument)]
    pub fn starter_document() -> String {
        crate::STARTER_DOCUMENT.to_string()
    }

    /// The path of the default main file.
    #[wasm_bindgen(js_name = starterPath)]
    pub fn starter_path() -> String {
        crate::STARTER_PATH.to_string()
    }

    fn parse_spec(spec: &str) -> Result<typst::syntax::package::PackageSpec, JsValue> {
        spec.parse()
            .map_err(|err| JsValue::from_str(&format!("invalid package spec: {err}")))
    }

    /// Serializes a value for JavaScript.
    ///
    /// `serialize_missing_as_null` matters: by default `Option::None` arrives
    /// as `undefined`, so a `null` check on the other side silently fails.
    /// Diagnostics without a span rely on exactly that check, so emitting
    /// `null` keeps the TypeScript types honest.
    fn to_js<T: serde::Serialize>(value: &T) -> Result<JsValue, JsValue> {
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
        value
            .serialize(&serializer)
            .map_err(|err| JsValue::from_str(&err.to_string()))
    }
}

#[cfg(target_arch = "wasm32")]
pub use bindings::*;
