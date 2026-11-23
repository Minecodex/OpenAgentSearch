use anyhow::{Context, Result, bail};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const REQUEST_LIMIT: usize = 1024 * 1024;
pub const RESPONSE_LIMIT: usize = 32 * 1024 * 1024;

pub async fn read_frame(reader: &mut (impl AsyncRead + Unpin), limit: usize) -> Result<Value> {
    let length = reader.read_u32_le().await? as usize;
    if length == 0 || length > limit {
        bail!("invalid native message length")
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).await?;
    let value: Value = serde_json::from_slice(&bytes)?;
    if !value.is_object() {
        bail!("native message must be an object")
    }
    Ok(value)
}

pub async fn write_frame(
    writer: &mut (impl AsyncWrite + Unpin),
    value: &Value,
    limit: usize,
) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.is_empty() || bytes.len() > limit {
        bail!("native message exceeds byte limit")
    }
    writer.write_u32_le(bytes.len() as u32).await?;
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

/// Firefox invokes the registered executable with its native-host manifest path.
/// This mode only relays framed messages to the private, authenticated socket.
pub async fn host(manifest: &std::path::Path) -> Result<()> {
    let config: Value =
        serde_json::from_slice(&tokio::fs::read(manifest.with_file_name("bridge.json")).await?)?;
    let mut connection =
        tokio::net::UnixStream::connect(config["socket"].as_str().context("native socket")?)
            .await?;
    write_frame(
        &mut connection,
        &serde_json::json!({"token":config["token"]}),
        1024,
    )
    .await?;
    let (mut read, mut write) = connection.into_split();
    let incoming = async {
        let mut input = tokio::io::stdin();
        loop {
            let value = read_frame(&mut input, RESPONSE_LIMIT).await?;
            write_frame(&mut write, &value, RESPONSE_LIMIT).await?;
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    };
    let outgoing = async {
        let mut output = tokio::io::stdout();
        loop {
            let value = read_frame(&mut read, REQUEST_LIMIT).await?;
            write_frame(&mut output, &value, REQUEST_LIMIT).await?;
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    };
    tokio::select! {result=incoming=>result,result=outgoing=>result}
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn native_frames_preserve_unicode_and_newlines_without_message_injection() {
        let (mut writer, mut reader) = tokio::io::duplex(2048);
        let value = json!({"id":7,"query":"天气\n{\"id\":8}"});
        write_frame(&mut writer, &value, REQUEST_LIMIT)
            .await
            .unwrap();
        assert_eq!(read_frame(&mut reader, REQUEST_LIMIT).await.unwrap(), value);
    }

    #[tokio::test]
    async fn invalid_native_lengths_and_non_objects_are_rejected() {
        for length in [0, REQUEST_LIMIT as u32 + 1] {
            let (mut writer, mut reader) = tokio::io::duplex(16);
            writer.write_u32_le(length).await.unwrap();
            assert!(read_frame(&mut reader, REQUEST_LIMIT).await.is_err());
        }
        let (mut writer, mut reader) = tokio::io::duplex(16);
        writer.write_all(&[2, 0, 0, 0, b'[', b']']).await.unwrap();
        assert!(read_frame(&mut reader, REQUEST_LIMIT).await.is_err());
    }
}
