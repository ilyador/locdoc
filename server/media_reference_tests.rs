//! Parity between the server's media references and the editor preview.
use super::*;

/// The editor renders only references the server would also authorize, so
/// both read the same cases. See `test/fixtures/media-references.json`.
#[test]
fn media_references_match_the_editor_fixtures() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../test/fixtures/media-references.json")).unwrap();
    for case in cases {
        let source = case["source"].as_str().unwrap();
        let mut actual: Vec<String> = Store::references(source).into_iter().collect();
        actual.sort();
        let mut expected: Vec<String> = case["references"]
            .as_array()
            .unwrap()
            .iter()
            .map(|reference| reference.as_str().unwrap().to_string())
            .collect();
        expected.sort();
        assert_eq!(actual, expected, "{}", case["name"]);
        // References the editor treats as local files.
        let local: Vec<&String> = actual
            .iter()
            .filter(|reference| media::local_reference(reference))
            .collect();
        let mut wanted: Vec<&str> = case["local"]
            .as_array()
            .unwrap()
            .iter()
            .map(|reference| reference.as_str().unwrap())
            .collect();
        wanted.sort();
        assert_eq!(local, wanted, "{}: local references", case["name"]);
        // The owner is told about exactly the images the editor previews:
        // none it never shows, and every one it does.
        let mut previewed: Vec<String> = media::previewed(source).into_iter().collect();
        previewed.sort();
        let mut rendered: Vec<String> = case["rendered"]
            .as_array()
            .unwrap()
            .iter()
            .map(|rendered| rendered["path"].as_str().unwrap().to_string())
            .collect();
        rendered.sort();
        assert_eq!(previewed, rendered, "{}: previewed images", case["name"]);
        for path in &rendered {
            assert!(
                expected.contains(path),
                "{}: the editor previews {path}, which the server never serves",
                case["name"]
            );
        }
    }
}
