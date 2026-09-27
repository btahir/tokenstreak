//! System events the worker reacts to: wake from sleep, and changes of the
//! clock or time zone. On wake the file watcher may have missed events and
//! the day may have rolled over, so the worker rescans; on a clock or zone
//! change it re-buckets days in the new zone.

/// What happened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemEvent {
    Wake,
    ClockChanged,
    TimeZoneChanged,
}

/// Subscribes `f` to system events for the app's lifetime. Must be called on
/// the main thread (Tauri's `setup`).
#[cfg(target_os = "macos")]
pub fn observe(f: impl Fn(SystemEvent) + Send + Sync + 'static) {
    use std::ptr::NonNull;
    use std::sync::Arc;

    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
    use objc2_foundation::{
        NSNotification, NSNotificationCenter, NSNotificationName, NSOperationQueue, NSSystemClockDidChangeNotification,
        NSSystemTimeZoneDidChangeNotification,
    };

    let f = Arc::new(f);
    let subscribe = |center: &NSNotificationCenter, name: &NSNotificationName, ev: SystemEvent| {
        let f = f.clone();
        let block = RcBlock::new(move |_n: NonNull<NSNotification>| f(ev));
        // SAFETY: a valid notification name, no object filter, the main
        // queue, and a block that is Send + Sync; the observer token is kept
        // alive for the whole process (it is never removed).
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                None,
                Some(&NSOperationQueue::mainQueue()),
                &block,
            )
        };
        std::mem::forget(token);
    };
    // SAFETY: reading framework-provided static notification names.
    unsafe {
        let workspace_center = NSWorkspace::sharedWorkspace().notificationCenter();
        subscribe(&workspace_center, NSWorkspaceDidWakeNotification, SystemEvent::Wake);
        let center = NSNotificationCenter::defaultCenter();
        subscribe(&center, NSSystemClockDidChangeNotification, SystemEvent::ClockChanged);
        subscribe(&center, NSSystemTimeZoneDidChangeNotification, SystemEvent::TimeZoneChanged);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn observe(_f: impl Fn(SystemEvent) + Send + Sync + 'static) {}
