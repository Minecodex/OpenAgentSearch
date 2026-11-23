use crate::{Error, Result, truncate};
use pulldown_cmark::{Event, Options, Parser};
use scraper::{ElementRef, Html, Selector};
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct Block {
    pub markdown: String,
    pub text: String,
}
#[derive(Debug, Clone)]
pub struct Article {
    pub title: String,
    pub blocks: Vec<Block>,
}
impl Article {
    pub fn html(body: &str) -> Result<Self> {
        let doc = Html::parse_document(body);
        let title = doc
            .select(&Selector::parse("title").unwrap())
            .next()
            .map(|e| e.text().collect::<String>())
            .unwrap_or_default();
        let root = doc
            .select(&Selector::parse("article,main,[role=main]").unwrap())
            .next()
            .or_else(|| doc.select(&Selector::parse("body").unwrap()).next())
            .unwrap_or_else(|| doc.root_element());
        let mut blocks = Vec::new();
        walk(root, &mut blocks);
        let article = Self { title, blocks };
        if article.text().trim().is_empty() {
            return Err(Error::new(
                "CONTENT_UNAVAILABLE",
                502,
                "网页没有可提取的正文。",
                "The page contains no readable article.",
            ));
        }
        Ok(article)
    }
    pub fn markdown(title: &str, body: &str) -> Result<Self> {
        let mut blocks = Vec::new();
        let mut depth = 0;
        let mut start = 0;
        for (event, range) in Parser::new_ext(body, Options::all()).into_offset_iter() {
            match event {
                Event::Start(_) => {
                    if depth == 0 {
                        start = range.start
                    }
                    depth += 1;
                }
                Event::End(_) => {
                    depth -= 1;
                    if depth == 0 {
                        let md = body[start..range.end].trim().to_owned();
                        let text = plain(&md);
                        if !text.trim().is_empty() {
                            blocks.push(Block { markdown: md, text });
                        }
                    }
                }
                Event::Text(t) if depth == 0 => blocks.push(Block {
                    markdown: t.to_string(),
                    text: t.to_string(),
                }),
                _ => {}
            }
        }
        if blocks.is_empty() && !body.trim().is_empty() {
            blocks.push(Block {
                markdown: body.to_owned(),
                text: plain(body),
            });
        }
        if blocks.is_empty() || blocks.iter().all(|b| b.text.trim().is_empty()) {
            return Err(Error::new(
                "CONTENT_UNAVAILABLE",
                502,
                "未取得有效正文。",
                "No article content was obtained.",
            ));
        }
        Ok(Self {
            title: title.into(),
            blocks,
        })
    }
    pub fn plain_text(title: &str, body: &str) -> Result<Self> {
        if body.trim().is_empty() {
            return Err(Error::new(
                "CONTENT_UNAVAILABLE",
                502,
                "没有可用于总结的文本。",
                "No readable text is available for synthesis.",
            ));
        }
        Ok(Self {
            title: title.to_owned(),
            blocks: vec![Block {
                markdown: escaped(body),
                text: body.to_owned(),
            }],
        })
    }
    pub fn text(&self) -> String {
        self.blocks
            .iter()
            .map(|b| b.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    }
    pub fn markdown_text(&self) -> String {
        self.blocks
            .iter()
            .map(|b| b.markdown.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    }
    pub fn data(&self, url: &str, final_url: Option<&str>, limit: usize) -> Value {
        let full_md = self.markdown_text();
        let full_text = self.text();
        let mut md = String::new();
        let mut text = String::new();
        for b in &self.blocks {
            let separator = if md.is_empty() { "" } else { "\n\n" };
            if md.chars().count() + separator.len() + b.markdown.chars().count() <= limit
                && text.chars().count() + separator.len() + b.text.chars().count() <= limit
            {
                md.push_str(separator);
                md.push_str(&b.markdown);
                text.push_str(separator);
                text.push_str(&b.text);
            } else {
                let remaining = limit
                    .saturating_sub(md.chars().count().max(text.chars().count()) + separator.len());
                if remaining > 0 {
                    let mut tail = truncate(&b.text, remaining);
                    while escaped(&tail).chars().count() > remaining {
                        tail.pop();
                    }
                    md.push_str(separator);
                    md.push_str(&escaped(&tail));
                    text.push_str(separator);
                    text.push_str(&tail);
                }
                break;
            }
        }
        let mut data = json!({"url":url,"title":self.title,"markdown":md,"text":text,
            "truncated":md!=full_md||text!=full_text,
            "lengths":{"markdown":{"original":full_md.chars().count(),"retained":md.chars().count()},
                "text":{"original":full_text.chars().count(),"retained":text.chars().count()}}});
        if let Some(u) = final_url {
            data["final_url"] = json!(u);
        }
        data
    }
}
fn plain(md: &str) -> String {
    let mut out = String::new();
    for event in Parser::new_ext(md, Options::all()) {
        match event {
            Event::Text(t) | Event::Code(t) => out.push_str(&t),
            Event::SoftBreak | Event::HardBreak => out.push('\n'),
            Event::End(_) if !out.ends_with('\n') => out.push('\n'),
            _ => {}
        }
    }
    out.trim().to_owned()
}
fn escaped(t: &str) -> String {
    let mut out = String::new();
    for c in t.chars() {
        if "\\`*_[]<>#".contains(c) {
            out.push('\\')
        }
        out.push(c);
    }
    out
}
fn inline(el: ElementRef<'_>) -> (String, String) {
    let name = el.value().name();
    if [
        "script", "style", "nav", "footer", "header", "form", "noscript", "svg", "button",
    ]
    .contains(&name)
    {
        return (String::new(), String::new());
    }
    let mut md = String::new();
    let mut text = String::new();
    for n in el.children() {
        if let Some(t) = n.value().as_text() {
            md.push_str(t);
            text.push_str(t);
        } else if let Some(e) = ElementRef::wrap(n) {
            let (a, b) = inline(e);
            md.push_str(&a);
            text.push_str(&b);
        }
    }
    match name {
        "strong" | "b" => md = format!("**{}**", md.trim()),
        "em" | "i" => md = format!("*{}*", md.trim()),
        "code" => md = format!("`{}`", md.trim().replace('`', "")),
        "a" => {
            if let Some(h) = el
                .value()
                .attr("href")
                .filter(|s| s.starts_with("https://") || s.starts_with("http://"))
            {
                md = format!("[{}]({})", md.trim(), h.replace(')', "%29"));
            }
        }
        "br" => {
            md.push_str("  \n");
            text.push('\n');
        }
        _ => {}
    }
    (md, text)
}
fn walk(el: ElementRef<'_>, blocks: &mut Vec<Block>) {
    let name = el.value().name();
    if [
        "script", "style", "nav", "footer", "header", "form", "noscript", "svg", "button",
    ]
    .contains(&name)
    {
        return;
    }
    if [
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "p",
        "li",
        "pre",
        "blockquote",
        "table",
    ]
    .contains(&name)
    {
        let (mut markdown, mut text) = inline(el);
        if text.trim().is_empty() {
            return;
        }
        if name.starts_with('h') && name.len() == 2 {
            markdown = format!(
                "{} {}",
                "#".repeat(name[1..].parse().unwrap_or(2)),
                markdown.trim()
            );
        }
        if name == "li" {
            markdown = format!("- {}", markdown.trim());
        }
        if name == "pre" {
            markdown = format!("```\n{}\n```", text.trim());
        }
        if name == "blockquote" {
            markdown = format!("> {}", markdown.trim());
        }
        if name == "table" {
            text = el
                .select(&Selector::parse("tr").unwrap())
                .map(|r| {
                    r.select(&Selector::parse("th,td").unwrap())
                        .map(|c| inline(c).1.trim().to_owned())
                        .collect::<Vec<_>>()
                        .join("\t")
                })
                .collect::<Vec<_>>()
                .join("\n");
            let rows = el
                .select(&Selector::parse("tr").unwrap())
                .map(|r| {
                    r.select(&Selector::parse("th,td").unwrap())
                        .map(|c| inline(c).0.trim().replace('|', "\\|"))
                        .collect::<Vec<_>>()
                })
                .filter(|r| !r.is_empty())
                .collect::<Vec<_>>();
            if let Some(first) = rows.first() {
                markdown = format!(
                    "| {} |\n| {} |",
                    first.join(" | "),
                    vec!["---"; first.len()].join(" | ")
                );
                for row in rows.iter().skip(1) {
                    markdown.push_str(&format!("\n| {} |", row.join(" | ")));
                }
            }
        }
        blocks.push(Block {
            markdown: markdown.trim().into(),
            text: text.trim().into(),
        });
        return;
    }
    let mut direct = String::new();
    for n in el.children() {
        if let Some(t) = n.value().as_text() {
            direct.push_str(t);
        } else if let Some(e) = ElementRef::wrap(n) {
            if !direct.trim().is_empty() {
                blocks.push(Block {
                    markdown: escaped(direct.trim()),
                    text: direct.trim().into(),
                });
            }
            direct.clear();
            walk(e, blocks);
        }
    }
    if !direct.trim().is_empty() {
        blocks.push(Block {
            markdown: escaped(direct.trim()),
            text: direct.trim().into(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dual_render_and_unicode_limits() {
        let a=Article::html("<html><title>观测</title><body><nav>忽略</nav><main><h1>雨量</h1><p>读<strong>毫米</strong>与<a href='https://example.org'>资料</a>。</p><pre>code</pre></main></body></html>").unwrap();
        assert!(!a.text().contains("忽略"));
        assert!(a.markdown_text().contains("**毫米**"));
        for n in 1..80 {
            let d = a.data("https://example.org", None, n);
            assert!(d["markdown"].as_str().unwrap().chars().count() <= n);
            assert!(d["text"].as_str().unwrap().chars().count() <= n);
        }
    }
    #[test]
    fn native_markdown_preserves_tables_and_code() {
        let a = Article::markdown(
            "Title",
            "# Title\n\n| A | B |\n|---|---|\n|1|2|\n\n```rs\nlet a=1;\n```",
        )
        .unwrap();
        assert!(a.text().contains("let a=1;"));
        assert!(a.markdown_text().contains("|1|2|"));
    }
}
