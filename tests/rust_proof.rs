use std::{
    collections::HashSet,
    fs::OpenOptions,
    io::Write,
    sync::{LazyLock, Mutex},
};
static ITEMS: LazyLock<HashSet<String>> = LazyLock::new(|| {
    let value: serde_json::Value =
        serde_json::from_str(include_str!("acceptance/subitems.json")).unwrap();
    value["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].as_str().unwrap().to_owned())
        .collect()
});
static OUTPUT: Mutex<()> = Mutex::new(());
#[track_caller]
pub fn check(id: &str, condition: bool) {
    assert!(ITEMS.contains(id), "Unknown acceptance subitem: {id}");
    if let Ok(file) = std::env::var("OAS_ASSERTIONS_FILE") {
        let caller = std::panic::Location::caller();
        let event = serde_json::json!({"version":1,"run_id":std::env::var("OAS_RUN_ID").unwrap(),"fingerprint":std::env::var("OAS_SOURCE_FINGERPRINT").unwrap(),"suite":std::env::var("OAS_SUITE").unwrap(),"id":id,"status":if condition{"passed"}else{"failed"},"assertions":1,"source":format!("{}:{}",caller.file(),caller.line())});
        let _lock = OUTPUT.lock().unwrap();
        let mut output = OpenOptions::new()
            .create(true)
            .append(true)
            .open(file)
            .unwrap();
        writeln!(output, "{event}").unwrap();
    }
    assert!(condition, "Acceptance subitem failed: {id}");
}
