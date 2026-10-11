use std::ffi::c_void;
use std::path::Path;

use futures::channel::mpsc::{UnboundedReceiver, unbounded};

#[cfg_attr(target_os = "linux", path = "media/mpris.rs")]
#[cfg_attr(target_os = "macos", path = "media/now_playing.rs")]
#[cfg_attr(windows, path = "media/smtc.rs")]
mod platform;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Command {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
    Stop,
    Seek(f64),
    SeekBy(f64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Status {
    Playing,
    Paused,
    #[default]
    Stopped,
}

pub struct Controls {
    inner: Option<platform::Controls>,
}

impl Controls {
    pub fn attach(window: Option<*mut c_void>) -> (Self, UnboundedReceiver<Command>) {
        let (commands, receiver) = unbounded();
        let inner = platform::Controls::new(window, commands)
            .map_err(|err| tracing::warn!(%err, "system media controls unavailable"))
            .ok();
        (Self { inner }, receiver)
    }

    pub fn set_track(&mut self, title: &str, duration: Option<f64>, art: Option<&Path>) {
        if let Some(inner) = &mut self.inner {
            inner.set_track(title, duration, art);
        }
    }

    pub fn set_status(&mut self, status: Status, position: f64) {
        if let Some(inner) = &mut self.inner {
            inner.set_status(status, position);
        }
    }
}
