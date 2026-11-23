use oas_domain::{Error, Result};
use std::sync::{Arc, LazyLock};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
static SLOTS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(4)));
/// The blocking task owns the permit even if its awaiting request is cancelled.
pub async fn run<T: Send + 'static>(
    cancel: &CancellationToken,
    compute: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let slot = tokio::select! {_=cancel.cancelled()=>return Err(Error::cancelled()),slot=SLOTS.clone().acquire_owned()=>slot.map_err(|_|Error::unavailable())?};
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        compute()
    })
    .await
    .map_err(|_| Error::internal())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelled_awaiters_do_not_release_running_cpu_permits() {
        let mut held = SLOTS.clone().acquire_many_owned(4).await.unwrap();
        drop(held.split(1).unwrap());
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        struct Release(Option<std::sync::mpsc::Sender<()>>);
        impl Drop for Release {
            fn drop(&mut self) {
                if let Some(sender) = self.0.take() {
                    let _ = sender.send(());
                }
            }
        }
        let finish = Release(Some(release));
        let task = tokio::spawn(async move {
            run(&CancellationToken::new(), move || {
                let _ = started.send(());
                let _ = wait.recv();
                Ok(())
            })
            .await
        });
        ready.await.unwrap();
        task.abort();
        let _ = task.await;
        crate::proof::check("A08.cpu_lifetime", SLOTS.available_permits() == 0);
        drop(finish);
        drop(held);
    }
}
