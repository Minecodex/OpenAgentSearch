use crate::{Error, Result};

pub fn count(encoding: &str, text: &str) -> Result<usize> {
    let bpe = match encoding {
        "cl100k_base" => tiktoken_rs::cl100k_base_singleton(),
        "o200k_base" => tiktoken_rs::o200k_base_singleton(),
        "p50k_base" => tiktoken_rs::p50k_base_singleton(),
        "r50k_base" => tiktoken_rs::r50k_base_singleton(),
        _ => return Err(Error::invalid("options.tokenizer")),
    };
    Ok(bpe.encode_ordinary(text).len())
}
pub fn split(
    encoding: &str,
    text: &str,
    max_tokens: usize,
    max_chunks: usize,
) -> Result<Vec<(usize, String)>> {
    let chars = text.chars().collect::<Vec<_>>();
    let mut result = Vec::new();
    let mut start = 0;
    while start < chars.len() && result.len() < max_chunks {
        let mut lo = start + 1;
        let mut hi = chars.len();
        let mut end = start;
        while lo <= hi {
            let middle = lo + (hi - lo) / 2;
            let slice = chars[start..middle].iter().collect::<String>();
            if count(encoding, &slice)? <= max_tokens {
                end = middle;
                lo = middle + 1;
            } else {
                hi = middle - 1;
            }
        }
        if end == start {
            return Err(Error::invalid("options.max_input_tokens"));
        }
        if end < chars.len()
            && let Some(i) = chars[start..end].iter().rposition(|c| *c == '\n')
            && i > (end - start) / 2
        {
            end = start + i + 1;
        }
        result.push((start, chars[start..end].iter().collect()));
        start = end;
    }
    Ok(result)
}
