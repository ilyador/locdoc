//! Parity between the server's media references and the editor preview.
use super::*;

/// The editor renders only references the server would also authorize, so
/// both read the same cases. See `test/fixtures/media-references.json`.
#[test]
fn media_references_match_the_editor_fixtures() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../test/fixtures/media-references.json")).unwrap();
    for case in cases {
        let mut actual: Vec<String> = Store::references(case["source"].as_str().unwrap())
            .into_iter()
            .collect();
        actual.sort();
        let mut expected: Vec<String> = case["references"]
            .as_array()
            .unwrap()
            .iter()
            .map(|reference| reference.as_str().unwrap().to_string())
            .collect();
        expected.sort();
        assert_eq!(actual, expected, "{}", case["name"]);
        for rendered in case["rendered"].as_array().unwrap() {
            let path = rendered["path"].as_str().unwrap();
            assert!(
                expected.iter().any(|reference| reference == path),
                "{}: the editor previews {path}, which the server never serves",
                case["name"]
            );
        }
    }
}
