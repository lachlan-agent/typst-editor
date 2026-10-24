//! An in-memory [`World`] backed by a virtual file system that the host
//! (JavaScript) pushes files into.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use typst::diag::{FileError, FileResult, PackageError};
use typst::ecow::EcoString;
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::package::PackageSpec;
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};

/// The document that is compiled when the host hasn't said otherwise.
pub const DEFAULT_MAIN: &str = "/main.typ";

/// An entry in the virtual file system.
enum Entry {
    /// A Typst source file. Kept as a [`Source`] so that edits can reuse the
    /// existing parse tree.
    Source(Source),
    /// Any other file: images, data, fonts referenced from the document.
    Binary(Bytes),
}

pub struct WebWorld {
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
    files: HashMap<FileId, Entry>,
    main: FileId,
    /// Packages whose files have been pushed in full.
    ///
    /// Tracked separately from `files` so that a missing file *inside* a
    /// loaded package reports "file not found" rather than sending the host
    /// off to download a package it already has.
    packages: HashSet<PackageSpec>,
    /// The same packages in list form, for `IdeWorld::packages`.
    package_list: Vec<(PackageSpec, Option<EcoString>)>,
    /// The current date, supplied by the host. `wasm32-unknown-unknown` has no
    /// clock, so this can never come from `SystemTime`.
    today: Option<Datetime>,
}

impl Default for WebWorld {
    fn default() -> Self {
        Self::new()
    }
}

impl WebWorld {
    pub fn new() -> Self {
        Self {
            library: LazyHash::new(Library::default()),
            book: LazyHash::new(FontBook::new()),
            fonts: Vec::new(),
            files: HashMap::new(),
            main: file_id(DEFAULT_MAIN),
            packages: HashSet::new(),
            package_list: Vec::new(),
            today: None,
        }
    }

    /// Registers every font face contained in `data`.
    pub fn add_font(&mut self, data: Bytes) {
        self.fonts.extend(Font::iter(data));
        self.book = LazyHash::new(FontBook::from_fonts(&self.fonts));
    }

    pub fn font_count(&self) -> usize {
        self.fonts.len()
    }

    /// Writes a text file. Existing sources are edited in place so that the
    /// incremental reparser can reuse the previous syntax tree.
    pub fn set_source(&mut self, path: &str, text: &str) {
        let id = file_id(path);
        match self.files.get_mut(&id) {
            Some(Entry::Source(source)) => {
                source.replace(text);
            }
            _ => {
                self.files
                    .insert(id, Entry::Source(Source::new(id, text.to_string())));
            }
        }
    }

    /// Writes a binary file.
    pub fn set_binary(&mut self, path: &str, data: Bytes) {
        self.files.insert(file_id(path), Entry::Binary(data));
    }

    pub fn remove_file(&mut self, path: &str) {
        self.files.remove(&file_id(path));
    }

    pub fn set_main(&mut self, path: &str) {
        self.main = file_id(path);
    }

    /// Sets the current date from a JavaScript timestamp (milliseconds since
    /// the Unix epoch), already shifted into the viewer's local time zone.
    pub fn set_today(&mut self, local_ms: f64) {
        let days = (local_ms / 86_400_000.0).floor() as i64;
        self.today = datetime_from_unix_days(days);
    }

    /// The source text of a file, if it is a text file we know about.
    pub fn source_text(&self, path: &str) -> Option<&str> {
        match self.files.get(&file_id(path)) {
            Some(Entry::Source(source)) => Some(source.text()),
            _ => None,
        }
    }

    /// Maps a [`FileId`] back to the path string the host used.
    pub fn path_of(id: FileId) -> String {
        id.get().vpath().get_with_slash().to_string()
    }

    /// Every source file currently loaded, project and package alike.
    pub fn sources(&self) -> impl Iterator<Item = &Source> {
        self.files.values().filter_map(|entry| match entry {
            Entry::Source(source) => Some(source),
            Entry::Binary(_) => None,
        })
    }

    /// Writes one file belonging to a package.
    ///
    /// Text files are stored as [`Source`]s so that package code participates
    /// in the same incremental parsing as the project's own files.
    pub fn add_package_file(&mut self, spec: &PackageSpec, path: &str, data: &[u8]) {
        let Ok(vpath) = VirtualPath::new(path) else {
            return;
        };
        let id = RootedPath::new(VirtualRoot::Package(spec.clone()), vpath).intern();

        let entry = match (path.ends_with(".typ"), std::str::from_utf8(data)) {
            (true, Ok(text)) => Entry::Source(Source::new(id, text.to_string())),
            _ => Entry::Binary(Bytes::new(data.to_vec())),
        };
        self.files.insert(id, entry);
    }

    /// Marks a package as fully present, so misses inside it stop asking the
    /// host to download it again.
    pub fn mark_package_loaded(&mut self, spec: PackageSpec) {
        if self.packages.insert(spec.clone()) {
            // `IdeWorld::packages` hands out a slice, so the list has to be
            // kept alongside the set rather than built on demand.
            self.package_list.push((spec, None));
        }
    }

    pub fn has_package(&self, spec: &PackageSpec) -> bool {
        self.packages.contains(spec)
    }

    fn not_found(&self, id: FileId) -> FileError {
        match id.get().root() {
            VirtualRoot::Project => FileError::NotFound(PathBuf::from(WebWorld::path_of(id))),
            VirtualRoot::Package(spec) if !self.packages.contains(spec) => {
                FileError::Package(PackageError::Other(Some(
                    format!("package {spec} has not been downloaded").into(),
                )))
            }
            VirtualRoot::Package(_) => FileError::NotFound(PathBuf::from(WebWorld::path_of(id))),
        }
    }
}

/// Extra context the IDE features use beyond plain compilation.
///
/// `files` drives path completion and `packages` drives package completion;
/// both are optional in the trait, but supplying them is what makes
/// `#import "` offer the project's own files and the packages already loaded.
impl typst_ide::IdeWorld for WebWorld {
    fn upcast(&self) -> &dyn World {
        self
    }

    fn files(&self) -> Vec<FileId> {
        // Project files only. Offering package-internal paths here would fill
        // path completion with files the author cannot reference.
        self.files
            .keys()
            .copied()
            .filter(|id| matches!(id.get().root(), VirtualRoot::Project))
            .collect()
    }

    fn packages(&self) -> &[(PackageSpec, Option<EcoString>)] {
        &self.package_list
    }
}

impl World for WebWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        match self.files.get(&id) {
            Some(Entry::Source(source)) => Ok(source.clone()),
            Some(Entry::Binary(_)) => Err(FileError::NotSource),
            None => Err(self.not_found(id)),
        }
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        match self.files.get(&id) {
            Some(Entry::Binary(bytes)) => Ok(bytes.clone()),
            Some(Entry::Source(source)) => Ok(Bytes::from_string(source.text().to_string())),
            None => Err(self.not_found(id)),
        }
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.get(index).cloned()
    }

    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        // The host already resolved the time zone for us, so any requested
        // offset is ignored rather than silently applied twice.
        self.today
    }
}

/// Interns a host-supplied path into a project-rooted [`FileId`].
///
/// Paths that can't be normalized fall back to the default main file, which
/// surfaces as an ordinary "file not found" rather than a panic.
pub fn file_id(path: &str) -> FileId {
    let vpath = VirtualPath::new(path)
        .or_else(|_| VirtualPath::new(DEFAULT_MAIN))
        .expect("default main path is valid");
    RootedPath::new(VirtualRoot::Project, vpath).intern()
}

/// Converts days since the Unix epoch into a [`Datetime`] (civil calendar).
///
/// Uses Howard Hinnant's `civil_from_days` algorithm so that no date/time
/// dependency is needed in the wasm build.
fn datetime_from_unix_days(days: i64) -> Option<Datetime> {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    Datetime::from_ymd(
        i32::try_from(y).ok()?,
        u8::try_from(m).ok()?,
        u8::try_from(d).ok()?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_matches_known_dates() {
        // 2024-02-29 is day 19782 of the Unix epoch — a leap day, which is
        // where off-by-one errors in the conversion show up.
        assert_eq!(
            datetime_from_unix_days(19782),
            Datetime::from_ymd(2024, 2, 29)
        );
        assert_eq!(datetime_from_unix_days(0), Datetime::from_ymd(1970, 1, 1));
    }

    #[test]
    fn unknown_project_file_is_not_found() {
        let world = WebWorld::new();
        let err = world.source(file_id("/missing.typ")).unwrap_err();
        assert!(matches!(err, FileError::NotFound(_)));
    }

    #[test]
    fn editing_a_source_keeps_it_readable() {
        let mut world = WebWorld::new();
        world.set_source(DEFAULT_MAIN, "= One");
        world.set_source(DEFAULT_MAIN, "= Two");
        assert_eq!(world.source_text(DEFAULT_MAIN), Some("= Two"));
    }
}
