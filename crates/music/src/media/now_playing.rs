use std::ffi::c_void;
use std::path::Path;
use std::ptr::NonNull;

use anyhow::Result;
use block2::RcBlock;
use futures::channel::mpsc::UnboundedSender;
use objc2::AnyThread as _;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::NSImage;
use objc2_core_foundation::CGSize;
use objc2_foundation::{NSMutableDictionary, NSNumber, NSString};
use objc2_media_player::{
    MPChangePlaybackPositionCommandEvent, MPMediaItemArtwork, MPMediaItemPropertyArtwork,
    MPMediaItemPropertyPlaybackDuration, MPMediaItemPropertyTitle, MPNowPlayingInfoCenter,
    MPNowPlayingInfoPropertyElapsedPlaybackTime, MPNowPlayingInfoPropertyPlaybackRate,
    MPNowPlayingPlaybackState, MPRemoteCommand, MPRemoteCommandCenter, MPRemoteCommandEvent,
    MPRemoteCommandHandlerStatus,
};

use super::{Command, Status};

const ART_POINTS: f64 = 512.0;

type Map = fn(&MPRemoteCommandEvent) -> Command;

pub struct Controls {
    targets: Vec<(Retained<MPRemoteCommand>, Retained<AnyObject>)>,
    title: String,
    duration: Option<f64>,
    art: Option<Retained<MPMediaItemArtwork>>,
    status: Status,
    position: f64,
}

impl Controls {
    pub fn new(_window: Option<*mut c_void>, commands: UnboundedSender<Command>) -> Result<Self> {
        let center = unsafe { MPRemoteCommandCenter::sharedCommandCenter() };
        let bindings: [(Retained<MPRemoteCommand>, Map); 7] = unsafe {
            [
                (center.playCommand(), |_| Command::Play),
                (center.pauseCommand(), |_| Command::Pause),
                (center.togglePlayPauseCommand(), |_| Command::Toggle),
                (center.stopCommand(), |_| Command::Stop),
                (center.nextTrackCommand(), |_| Command::Next),
                (center.previousTrackCommand(), |_| Command::Previous),
                (center.changePlaybackPositionCommand().into_super(), seek),
            ]
        };
        let targets = bindings
            .into_iter()
            .map(|(command, map)| {
                let commands = commands.clone();
                let handler = RcBlock::new(move |event: NonNull<MPRemoteCommandEvent>| {
                    let _ = commands.unbounded_send(map(unsafe { event.as_ref() }));
                    MPRemoteCommandHandlerStatus::Success
                });
                let target = unsafe {
                    command.setEnabled(true);
                    command.addTargetWithHandler(&handler)
                };
                (command, target)
            })
            .collect();
        Ok(Self {
            targets,
            title: String::new(),
            duration: None,
            art: None,
            status: Status::Stopped,
            position: 0.0,
        })
    }

    pub fn set_track(&mut self, title: &str, duration: Option<f64>, art: Option<&Path>) {
        self.title = title.to_owned();
        self.duration = duration;
        self.art = art.and_then(artwork);
        self.publish();
    }

    pub fn set_status(&mut self, status: Status, position: f64) {
        self.status = status;
        self.position = position;
        self.publish();
    }

    fn publish(&self) {
        let info = NSMutableDictionary::<NSString, AnyObject>::new();
        let rate = if self.status == Status::Playing { 1.0 } else { 0.0 };
        unsafe {
            info.insert(MPMediaItemPropertyTitle, &NSString::from_str(&self.title));
            if let Some(duration) = self.duration {
                info.insert(
                    MPMediaItemPropertyPlaybackDuration,
                    &NSNumber::new_f64(duration),
                );
            }
            if let Some(art) = &self.art {
                info.insert(MPMediaItemPropertyArtwork, art);
            }
            info.insert(
                MPNowPlayingInfoPropertyElapsedPlaybackTime,
                &NSNumber::new_f64(self.position),
            );
            info.insert(MPNowPlayingInfoPropertyPlaybackRate, &NSNumber::new_f64(rate));
            let center = MPNowPlayingInfoCenter::defaultCenter();
            center.setNowPlayingInfo(Some(&info));
            center.setPlaybackState(match self.status {
                Status::Playing => MPNowPlayingPlaybackState::Playing,
                Status::Paused => MPNowPlayingPlaybackState::Paused,
                Status::Stopped => MPNowPlayingPlaybackState::Stopped,
            });
        }
    }
}

impl Drop for Controls {
    fn drop(&mut self) {
        unsafe {
            for (command, target) in &self.targets {
                command.removeTarget(Some(target));
                command.setEnabled(false);
            }
            let center = MPNowPlayingInfoCenter::defaultCenter();
            center.setNowPlayingInfo(None);
            center.setPlaybackState(MPNowPlayingPlaybackState::Stopped);
        }
    }
}

fn seek(event: &MPRemoteCommandEvent) -> Command {
    let event: &MPChangePlaybackPositionCommandEvent =
        unsafe { &*(event as *const MPRemoteCommandEvent).cast() };
    Command::Seek(unsafe { event.positionTime() })
}

fn artwork(path: &Path) -> Option<Retained<MPMediaItemArtwork>> {
    let image = NSImage::initWithContentsOfFile(
        NSImage::alloc(),
        &NSString::from_str(&path.to_string_lossy()),
    )?;
    let handler = RcBlock::new(move |_: CGSize| NonNull::from(&*image));
    Some(unsafe {
        MPMediaItemArtwork::initWithBoundsSize_requestHandler(
            MPMediaItemArtwork::alloc(),
            CGSize::new(ART_POINTS, ART_POINTS),
            &handler,
        )
    })
}
