//! End-to-end tests of the compile engine, run natively against the fonts
//! bundled with `typst-assets`.

use typst::foundations::Bytes;
use typst::syntax::package::PackageSpec;
use typst_wasm::{Engine, STARTER_DOCUMENT, STARTER_PATH};

fn engine_with_fonts() -> Engine {
    let mut engine = Engine::new();
    for data in typst_assets::fonts() {
        engine.world_mut().add_font(Bytes::new(data));
    }
    assert!(engine.world().font_count() > 0, "no fonts were registered");
    engine
}

#[test]
fn compiles_a_document_to_svg() {
    let mut engine = engine_with_fonts();
    engine
        .world_mut()
        .set_source(STARTER_PATH, "= Hello\n\nSome #emph[text].");

    let out = engine.compile_svg();
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
    assert_eq!(out.pages.len(), 1);
    assert!(out.pages[0].starts_with("<svg"));
}

#[test]
fn the_starter_document_compiles_cleanly() {
    let mut engine = engine_with_fonts();
    engine
        .world_mut()
        .set_source(STARTER_PATH, STARTER_DOCUMENT);

    let out = engine.compile_svg();
    let errors: Vec<_> = out
        .diagnostics
        .iter()
        .filter(|d| d.severity == "error")
        .collect();
    assert!(errors.is_empty(), "{errors:?}");
    assert_eq!(out.pages.len(), 1);
}

#[test]
fn a_page_break_produces_two_pages() {
    let mut engine = engine_with_fonts();
    engine
        .world_mut()
        .set_source(STARTER_PATH, "First\n#pagebreak()\nSecond");

    assert_eq!(engine.compile_svg().pages.len(), 2);
}

#[test]
fn an_error_carries_the_right_byte_range() {
    let mut engine = engine_with_fonts();
    let text = "Fine.\n\n#nope()\n";
    engine.world_mut().set_source(STARTER_PATH, text);

    let out = engine.compile_svg();
    assert!(out.pages.is_empty());
    let diag = out
        .diagnostics
        .iter()
        .find(|d| d.severity == "error")
        .expect("expected an error");

    assert_eq!(diag.path.as_deref(), Some(STARTER_PATH));
    let (from, to) = (diag.from.unwrap(), diag.to.unwrap());
    assert_eq!(&text[from..to], "nope");
}

#[test]
fn includes_resolve_across_files() {
    let mut engine = engine_with_fonts();
    engine
        .world_mut()
        .set_source(STARTER_PATH, "#include \"/chapter.typ\"");
    engine
        .world_mut()
        .set_source("/chapter.typ", "= Chapter\n\nBody.");

    let out = engine.compile_svg();
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
    assert_eq!(out.pages.len(), 1);
}

#[test]
fn a_missing_include_reports_the_missing_path() {
    let mut engine = engine_with_fonts();
    engine
        .world_mut()
        .set_source(STARTER_PATH, "#include \"/gone.typ\"");

    let out = engine.compile_svg();
    let diag = out
        .diagnostics
        .iter()
        .find(|d| d.severity == "error")
        .expect("expected an error");
    assert!(diag.message.contains("gone.typ"), "{}", diag.message);
}

/// Installs a minimal but real package: a manifest plus its entrypoint.
fn install_package(engine: &mut Engine, spec_text: &str, entrypoint: &str, lib: &str) {
    let spec: PackageSpec = spec_text.parse().unwrap();
    let manifest = format!(
        "[package]\nname = \"{}\"\nversion = \"{}\"\nentrypoint = \"{}\"\n",
        spec.name, spec.version, entrypoint
    );
    engine
        .world_mut()
        .add_package_file(&spec, "/typst.toml", manifest.as_bytes());
    engine
        .world_mut()
        .add_package_file(&spec, &format!("/{entrypoint}"), lib.as_bytes());
    engine.world_mut().mark_package_loaded(spec);
}

#[test]
fn a_package_that_is_not_downloaded_says_so() {
    let mut engine = engine_with_fonts();
    engine
        .world_mut()
        .set_source(STARTER_PATH, "#import \"@preview/cetz:0.3.1\": *");

    let out = engine.compile_svg();
    let diag = out
        .diagnostics
        .iter()
        .find(|d| d.severity == "error")
        .expect("expected an error");
    assert!(
        diag.message.contains("has not been downloaded"),
        "unexpected message: {}",
        diag.message
    );
}

#[test]
fn missing_packages_are_reported_for_download() {
    let mut engine = engine_with_fonts();
    engine.world_mut().set_source(
        STARTER_PATH,
        "#import \"@preview/one:1.0.0\": *\n#import \"@preview/two:2.1.0\"\n",
    );

    assert_eq!(
        engine.missing_packages(),
        vec!["@preview/one:1.0.0", "@preview/two:2.1.0"]
    );
}

#[test]
fn a_loaded_package_compiles_and_stops_being_missing() {
    let mut engine = engine_with_fonts();
    engine.world_mut().set_source(
        STARTER_PATH,
        "#import \"@preview/greet:1.0.0\": hello\n#hello[world]",
    );
    install_package(
        &mut engine,
        "@preview/greet:1.0.0",
        "lib.typ",
        "#let hello(body) = [Hello, #body!]",
    );

    assert!(engine.missing_packages().is_empty());
    let out = engine.compile_svg();
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
    assert_eq!(out.pages.len(), 1);
}

#[test]
fn a_package_entrypoint_in_a_subdirectory_resolves() {
    let mut engine = engine_with_fonts();
    engine
        .world_mut()
        .set_source(STARTER_PATH, "#import \"@preview/nested:0.2.0\": tag\n#tag");
    install_package(
        &mut engine,
        "@preview/nested:0.2.0",
        "src/lib.typ",
        "#let tag = [ok]",
    );

    let out = engine.compile_svg();
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
}

#[test]
fn a_package_depending_on_a_package_surfaces_on_the_next_scan() {
    let mut engine = engine_with_fonts();
    engine
        .world_mut()
        .set_source(STARTER_PATH, "#import \"@preview/outer:1.0.0\": *");

    assert_eq!(engine.missing_packages(), vec!["@preview/outer:1.0.0"]);

    // Loading `outer` reveals its own dependency, which is why the host loops
    // rather than downloading a single round.
    install_package(
        &mut engine,
        "@preview/outer:1.0.0",
        "lib.typ",
        "#import \"@preview/inner:0.5.0\": *",
    );
    assert_eq!(engine.missing_packages(), vec!["@preview/inner:0.5.0"]);
}

#[test]
fn a_missing_file_inside_a_loaded_package_is_not_a_download_failure() {
    let mut engine = engine_with_fonts();
    engine.world_mut().set_source(
        STARTER_PATH,
        "#import \"@preview/greet:1.0.0\": *\n#include \"@preview/greet:1.0.0\"",
    );
    install_package(&mut engine, "@preview/greet:1.0.0", "lib.typ", "#let x = 1");

    // The package is present, so nothing more should be downloaded.
    assert!(engine.missing_packages().is_empty());
}

#[cfg(feature = "pdf")]
#[test]
fn exports_a_pdf() {
    let mut engine = engine_with_fonts();
    engine.world_mut().set_source(STARTER_PATH, "= Hello");

    let out = engine.compile_pdf();
    let data = out.data.expect("expected PDF bytes");
    assert!(data.starts_with(b"%PDF-"));
}

#[cfg(feature = "pdf")]
#[test]
fn a_failed_compile_yields_no_pdf() {
    let mut engine = engine_with_fonts();
    engine.world_mut().set_source(STARTER_PATH, "#nope()");

    let out = engine.compile_pdf();
    assert!(out.data.is_none());
    assert!(out.diagnostics.iter().any(|d| d.severity == "error"));
}

#[test]
fn highlighting_tags_a_known_snippet() {
    let mut engine = Engine::new();
    let text = "= Heading\n\n#let x = 1\n";
    engine.world_mut().set_source(STARTER_PATH, text);

    let tokens = engine.highlight(STARTER_PATH);
    let tags: Vec<_> = tokens.iter().map(|t| t.tag).collect();
    assert!(tags.contains(&"heading"), "{tags:?}");
    assert!(tags.contains(&"keyword"), "{tags:?}");
    assert!(tags.contains(&"number"), "{tags:?}");

    // Every token must be a valid, non-empty slice of the source.
    for token in &tokens {
        assert!(token.from < token.to, "{token:?}");
        assert!(text.get(token.from..token.to).is_some(), "{token:?}");
    }
}

#[test]
fn highlighting_an_unknown_file_is_empty_rather_than_an_error() {
    let engine = Engine::new();
    assert!(engine.highlight("/nothing-here.typ").is_empty());
}

#[test]
fn recompiling_after_an_edit_picks_up_the_new_text() {
    let mut engine = engine_with_fonts();
    engine.world_mut().set_source(STARTER_PATH, "First");
    let first = engine.compile_svg();

    engine
        .world_mut()
        .set_source(STARTER_PATH, "First\n#pagebreak()\nSecond");
    let second = engine.compile_svg();

    assert_eq!(first.pages.len(), 1);
    assert_eq!(second.pages.len(), 2);
}

#[test]
fn completes_a_function_after_a_hash() {
    let mut engine = engine_with_fonts();
    let text = "#im";
    engine.world_mut().set_source(STARTER_PATH, text);

    let completions = engine.autocomplete(STARTER_PATH, text.len(), false);
    let labels: Vec<&str> = completions.items.iter().map(|c| c.label.as_str()).collect();
    assert!(labels.contains(&"image"), "{labels:?}");
    assert!(completions.items.iter().any(|c| c.kind == "func"));
}

#[test]
fn completes_parameters_inside_a_call() {
    let mut engine = engine_with_fonts();
    // The closing paren matters: an unclosed call has no `Args` node to look
    // inside, so nothing is offered. The editor closes brackets as you type,
    // which is what makes this the ordinary case.
    let text = "#text()";
    engine.world_mut().set_source(STARTER_PATH, text);

    let completions = engine.autocomplete(STARTER_PATH, text.len() - 1, true);
    let labels: Vec<&str> = completions.items.iter().map(|c| c.label.as_str()).collect();
    assert!(labels.contains(&"size"), "{labels:?}");
    assert!(labels.contains(&"font"), "{labels:?}");
}

#[test]
fn completion_details_carry_documentation() {
    let mut engine = engine_with_fonts();
    let text = "#emp";
    engine.world_mut().set_source(STARTER_PATH, text);

    let completions = engine.autocomplete(STARTER_PATH, text.len(), false);
    let emph = completions
        .items
        .iter()
        .find(|c| c.label == "emph")
        .expect("expected emph");
    assert!(emph.detail.is_some(), "emph should carry a description");
}

#[test]
fn completes_labels_from_the_compiled_document() {
    let mut engine = engine_with_fonts();
    // Labels only exist once the document has been laid out, which is why the
    // engine keeps the last successful compilation around.
    let text = "= Introduction <intro>\n\nSee @";
    engine.world_mut().set_source(STARTER_PATH, text);
    engine.compile_svg();

    let completions = engine.autocomplete(STARTER_PATH, text.len(), false);
    let labels: Vec<&str> = completions.items.iter().map(|c| c.label.as_str()).collect();
    assert!(labels.contains(&"intro"), "{labels:?}");
}

#[test]
fn completes_paths_from_other_project_files() {
    let mut engine = engine_with_fonts();
    let text = "#include \"\"";
    engine.world_mut().set_source(STARTER_PATH, text);
    engine.world_mut().set_source("/chapter.typ", "= Chapter");

    // Between the quotes. This is what `IdeWorld::files` exists to supply.
    let completions = engine.autocomplete(STARTER_PATH, text.len() - 1, true);
    let labels: Vec<String> = completions.items.iter().map(|c| c.label.clone()).collect();
    assert!(
        labels.iter().any(|l| l.contains("chapter.typ")),
        "{labels:?}"
    );
}

#[test]
fn autocomplete_on_an_unknown_file_is_empty() {
    let engine = engine_with_fonts();
    assert!(engine.autocomplete("/nope.typ", 0, true).items.is_empty());
}

#[test]
fn autocomplete_past_the_end_does_not_panic() {
    let mut engine = engine_with_fonts();
    engine.world_mut().set_source(STARTER_PATH, "#im");
    // A stale cursor from the host must be survivable.
    engine.autocomplete(STARTER_PATH, 9_999, false);
}

#[test]
fn autocomplete_inside_a_multibyte_character_does_not_panic() {
    let mut engine = engine_with_fonts();
    let text = "Grüße #im";
    engine.world_mut().set_source(STARTER_PATH, text);
    // Byte 4 is the middle of "ü".
    engine.autocomplete(STARTER_PATH, 4, false);
}

#[test]
fn hovering_a_function_returns_documentation() {
    let mut engine = engine_with_fonts();
    let text = "#emph[hi]";
    engine.world_mut().set_source(STARTER_PATH, text);

    // Cursor inside the word "emph".
    let hover = engine.hover(STARTER_PATH, 3).expect("expected a tooltip");
    assert!(!hover.value.is_empty());
    assert!(hover.kind == "text" || hover.kind == "code");
}

#[test]
fn hovering_plain_prose_returns_nothing() {
    let mut engine = engine_with_fonts();
    engine
        .world_mut()
        .set_source(STARTER_PATH, "Just some words here.");
    assert!(engine.hover(STARTER_PATH, 5).is_none());
}

#[test]
fn hovering_an_unknown_file_returns_nothing() {
    let engine = engine_with_fonts();
    assert!(engine.hover("/nope.typ", 0).is_none());
}

#[test]
fn hovering_inside_a_multibyte_character_does_not_panic() {
    let mut engine = engine_with_fonts();
    engine
        .world_mut()
        .set_source(STARTER_PATH, "Grüße #emph[x]");
    engine.hover(STARTER_PATH, 4);
}

#[test]
fn formats_source() {
    let engine = typst_wasm::Engine::new();
    let formatted = engine
        .format("#let  f(x)={x+1}\n= Title\nSome   text.\n", 80, 2)
        .expect("valid source formats");
    assert!(formatted.contains("#let f(x) = { x + 1 }"), "{formatted}");
    assert!(engine.format("#let (", 80, 2).is_err());
}
