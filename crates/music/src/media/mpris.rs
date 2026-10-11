use std::collections::HashMap;
use std::ffi::c_void;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use anyhow::Result;
use futures::StreamExt as _;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use zbus::object_server::SignalEmitter;
use zbus::zvariant::{ObjectPath, Value};

use super::{Command, Status};

const BUS_NAME: &str = "org.mpris.MediaPlayer2.zeron";
const PATH: &str = "/org/mpris/MediaPlayer2";
const TRACK: &str = "/org/zeron/music/track";

#[derive(Default)]
struct State {
    title: String,
    duration: Option<f64>,
    art: Option<String>,
    status: Status,
    position: f64,
    since: Option<Instant>,
}

impl State {
    fn position(&self) -> f64 {
        self.position + self.since.map_or(0.0, |since| since.elapsed().as_secs_f64())
    }
}

enum Update {
    Track,
    Status,
}

pub struct Controls {
    state: Arc<Mutex<State>>,
    updates: UnboundedSender<Update>,
}

impl Controls {
    pub fn new(_window: Option<*mut c_void>, commands: UnboundedSender<Command>) -> Result<Self> {
        let state = Arc::new(Mutex::new(State::default()));
        let (updates, receiver) = unbounded();
        let shared = state.clone();
        std::thread::Builder::new()
            .name("zeron-mpris".into())
            .spawn(move || {
                if let Err(err) = futures::executor::block_on(serve(shared, commands, receiver)) {
                    tracing::warn!(%err, "mpris unavailable");
                }
            })?;
        Ok(Self { state, updates })
    }

    pub fn set_track(&mut self, title: &str, duration: Option<f64>, art: Option<&Path>) {
        {
            let mut state = self.state.lock().expect("mpris state");
            state.title = title.to_owned();
            state.duration = duration;
            state.art = art.map(|path| format!("file://{}", path.display()));
        }
        let _ = self.updates.unbounded_send(Update::Track);
    }

    pub fn set_status(&mut self, status: Status, position: f64) {
        {
            let mut state = self.state.lock().expect("mpris state");
            state.status = status;
            state.position = position;
            state.since = (status == Status::Playing).then(Instant::now);
        }
        let _ = self.updates.unbounded_send(Update::Status);
    }
}

fn micros(seconds: f64) -> i64 {
    (seconds * 1_000_000.0) as i64
}

async fn serve(
    state: Arc<Mutex<State>>,
    commands: UnboundedSender<Command>,
    mut updates: UnboundedReceiver<Update>,
) -> zbus::Result<()> {
    let connection = zbus::connection::Builder::session()?
        .name(BUS_NAME)?
        .serve_at(PATH, Root)?
        .serve_at(
            PATH,
            Player {
                state: state.clone(),
                commands,
            },
        )?
        .build()
        .await?;
    let player = connection
        .object_server()
        .interface::<_, Player>(PATH)
        .await?;
    while let Some(update) = updates.next().await {
        let emitter = player.signal_emitter();
        match update {
            Update::Track => player.get().await.metadata_changed(emitter).await?,
            Update::Status => {
                player.get().await.playback_status_changed(emitter).await?;
                let position = micros(state.lock().expect("mpris state").position);
                Player::seeked(emitter, position).await?;
            }
        }
    }
    Ok(())
}

struct Root;

#[zbus::interface(name = "org.mpris.MediaPlayer2")]
impl Root {
    fn raise(&self) {}

    fn quit(&self) {}

    #[zbus(property)]
    fn can_quit(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn can_raise(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn has_track_list(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn identity(&self) -> &str {
        "Zeron"
    }

    #[zbus(property)]
    fn desktop_entry(&self) -> &str {
        "zeron"
    }

    #[zbus(property)]
    fn supported_uri_schemes(&self) -> Vec<String> {
        Vec::new()
    }

    #[zbus(property)]
    fn supported_mime_types(&self) -> Vec<String> {
        Vec::new()
    }
}

struct Player {
    state: Arc<Mutex<State>>,
    commands: UnboundedSender<Command>,
}

impl Player {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("mpris state")
    }

    fn send(&self, command: Command) {
        let _ = self.commands.unbounded_send(command);
    }
}

#[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
impl Player {
    fn next(&self) {
        self.send(Command::Next);
    }

    fn previous(&self) {
        self.send(Command::Previous);
    }

    fn pause(&self) {
        self.send(Command::Pause);
    }

    fn play_pause(&self) {
        self.send(Command::Toggle);
    }

    fn stop(&self) {
        self.send(Command::Stop);
    }

    fn play(&self) {
        self.send(Command::Play);
    }

    fn seek(&self, offset: i64) {
        self.send(Command::SeekBy(offset as f64 / 1_000_000.0));
    }

    fn set_position(&self, track: ObjectPath<'_>, position: i64) {
        if track.as_str() == TRACK {
            self.send(Command::Seek(position as f64 / 1_000_000.0));
        }
    }

    fn open_uri(&self, _uri: &str) {}

    #[zbus(signal)]
    async fn seeked(emitter: &SignalEmitter<'_>, position: i64) -> zbus::Result<()>;

    #[zbus(property)]
    fn playback_status(&self) -> &str {
        match self.state().status {
            Status::Playing => "Playing",
            Status::Paused => "Paused",
            Status::Stopped => "Stopped",
        }
    }

    #[zbus(property)]
    fn rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn set_rate(&self, _rate: f64) {}

    #[zbus(property)]
    fn metadata(&self) -> HashMap<&str, Value<'_>> {
        let state = self.state();
        let mut metadata = HashMap::from([
            (
                "mpris:trackid",
                Value::ObjectPath(ObjectPath::from_static_str_unchecked(TRACK)),
            ),
            ("xesam:title", Value::Str(state.title.clone().into())),
        ]);
        if let Some(duration) = state.duration {
            metadata.insert("mpris:length", Value::I64(micros(duration)));
        }
        if let Some(art) = &state.art {
            metadata.insert("mpris:artUrl", Value::Str(art.clone().into()));
        }
        metadata
    }

    #[zbus(property)]
    fn volume(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn set_volume(&self, _volume: f64) {}

    #[zbus(property(emits_changed_signal = "false"))]
    fn position(&self) -> i64 {
        micros(self.state().position())
    }

    #[zbus(property)]
    fn minimum_rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn maximum_rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_play(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_pause(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_seek(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_control(&self) -> bool {
        true
    }
}
