use std::io;
use tokio::process::{Child, Command};
use tokio::runtime::Handle;

pub struct BrowserProcess {
    child: Option<Child>,
    runtime: Handle,
}
impl BrowserProcess {
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        Ok(Self {
            child: Some(command.kill_on_drop(true).spawn()?),
            runtime: Handle::current(),
        })
    }
    fn stop(&mut self) -> Option<Child> {
        let mut child = self.child.take()?;
        #[cfg(unix)]
        if let Some(pid) = child.id() {
            // Every browser owns a new process group, including its Firefox children.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = child.start_kill();
        Some(child)
    }
}
impl Drop for BrowserProcess {
    fn drop(&mut self) {
        if let Some(mut child) = self.stop() {
            // Reap our own browser even if dropping the session cancelled its operation.
            // Firefox descendants orphaned by the group shutdown are reaped by container init.
            self.runtime.spawn(async move {
                if let Err(error) = child.wait().await {
                    tracing::warn!(%error, "could not reap Firefox");
                }
            });
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::{path::PathBuf, time::Duration};

    #[tokio::test]
    async fn retiring_one_browser_reaps_it_without_consuming_another_childs_status() {
        let mut command = Command::new("sleep");
        command.arg("60");
        let browser = BrowserProcess::spawn(&mut command).unwrap();
        let pid = browser.child.as_ref().unwrap().id().unwrap();
        let proc_entry = PathBuf::from(format!("/proc/{pid}"));
        let mut other = Command::new("sh").args(["-c", "exit 23"]).spawn().unwrap();

        std::thread::spawn(move || drop(browser)).join().unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while proc_entry.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("browser must be reaped without another job");
        assert_eq!(other.wait().await.unwrap().code(), Some(23));
    }
}
