use std::ffi::c_void;
use std::path::Path;

use anyhow::{Result, anyhow};
use futures::channel::mpsc::UnboundedSender;
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Media::{
    MediaPlaybackStatus, MediaPlaybackType, PlaybackPositionChangeRequestedEventArgs,
    SystemMediaTransportControls, SystemMediaTransportControlsButton,
    SystemMediaTransportControlsButtonPressedEventArgs,
    SystemMediaTransportControlsTimelineProperties,
};
use windows::Storage::StorageFile;
use windows::Storage::Streams::RandomAccessStreamReference;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;
use windows::core::{HSTRING, Ref};

use super::{Command, Status};

const TICKS_PER_SECOND: f64 = 10_000_000.0;

pub struct Controls {
    controls: SystemMediaTransportControls,
    timeline: SystemMediaTransportControlsTimelineProperties,
    buttons: i64,
    positions: i64,
}

impl Controls {
    pub fn new(window: Option<*mut c_void>, commands: UnboundedSender<Command>) -> Result<Self> {
        let window = window.ok_or_else(|| anyhow!("no window handle"))?;
        let interop = windows::core::factory::<
            SystemMediaTransportControls,
            ISystemMediaTransportControlsInterop,
        >()?;
        let controls: SystemMediaTransportControls =
            unsafe { interop.GetForWindow(HWND(window)) }?;
        controls.SetIsEnabled(true)?;
        controls.SetIsPlayEnabled(true)?;
        controls.SetIsPauseEnabled(true)?;
        controls.SetIsStopEnabled(true)?;
        controls.SetIsNextEnabled(true)?;
        controls.SetIsPreviousEnabled(true)?;
        let buttons = controls.ButtonPressed(&TypedEventHandler::new({
            let commands = commands.clone();
            move |_, args: Ref<SystemMediaTransportControlsButtonPressedEventArgs>| {
                let command = match args.ok()?.Button()? {
                    SystemMediaTransportControlsButton::Play => Command::Play,
                    SystemMediaTransportControlsButton::Pause => Command::Pause,
                    SystemMediaTransportControlsButton::Stop => Command::Stop,
                    SystemMediaTransportControlsButton::Next => Command::Next,
                    SystemMediaTransportControlsButton::Previous => Command::Previous,
                    _ => return Ok(()),
                };
                let _ = commands.unbounded_send(command);
                Ok(())
            }
        }))?;
        let positions = controls.PlaybackPositionChangeRequested(&TypedEventHandler::new(
            move |_, args: Ref<PlaybackPositionChangeRequestedEventArgs>| {
                let position = args.ok()?.RequestedPlaybackPosition()?;
                let _ = commands.unbounded_send(Command::Seek(
                    position.Duration as f64 / TICKS_PER_SECOND,
                ));
                Ok(())
            },
        ))?;
        Ok(Self {
            controls,
            timeline: SystemMediaTransportControlsTimelineProperties::new()?,
            buttons,
            positions,
        })
    }

    pub fn set_track(&mut self, title: &str, duration: Option<f64>, art: Option<&Path>) {
        if let Err(err) = self.display(title, duration, art) {
            tracing::warn!(%err, "media controls metadata");
        }
    }

    pub fn set_status(&mut self, status: Status, position: f64) {
        let result = self
            .controls
            .SetPlaybackStatus(match status {
                Status::Playing => MediaPlaybackStatus::Playing,
                Status::Paused => MediaPlaybackStatus::Paused,
                Status::Stopped => MediaPlaybackStatus::Stopped,
            })
            .and_then(|()| self.timeline.SetPosition(ticks(position)))
            .and_then(|()| self.controls.UpdateTimelineProperties(&self.timeline));
        if let Err(err) = result {
            tracing::warn!(%err, "media controls status");
        }
    }

    fn display(
        &self,
        title: &str,
        duration: Option<f64>,
        art: Option<&Path>,
    ) -> windows::core::Result<()> {
        let updater = self.controls.DisplayUpdater()?;
        updater.SetType(MediaPlaybackType::Music)?;
        updater.MusicProperties()?.SetTitle(&HSTRING::from(title))?;
        let thumbnail = art
            .map(|path| {
                let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))?.join()?;
                RandomAccessStreamReference::CreateFromFile(&file)
            })
            .transpose()?;
        updater.SetThumbnail(thumbnail.as_ref())?;
        updater.Update()?;
        let end = ticks(duration.unwrap_or(0.0));
        self.timeline.SetStartTime(TimeSpan::default())?;
        self.timeline.SetMinSeekTime(TimeSpan::default())?;
        self.timeline.SetEndTime(end)?;
        self.timeline.SetMaxSeekTime(end)?;
        self.controls.UpdateTimelineProperties(&self.timeline)
    }
}

impl Drop for Controls {
    fn drop(&mut self) {
        let _ = self.controls.RemoveButtonPressed(self.buttons);
        let _ = self
            .controls
            .RemovePlaybackPositionChangeRequested(self.positions);
        let _ = self.controls.SetIsEnabled(false);
    }
}

fn ticks(seconds: f64) -> TimeSpan {
    TimeSpan {
        Duration: (seconds * TICKS_PER_SECOND) as i64,
    }
}
