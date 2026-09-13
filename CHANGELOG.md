# Change Log

All notable changes to the "Salesforce AG Log Viewer" extension will be documented in this file.

## [1.2.8]
### Added
- Show readable variable declarations and assignments with type badges, typed values, and previous recorded values within the same invocation.
- Inspect recorded objects, lists and strings, view or copy the original event, and identify explicitly truncated values without losing numeric precision.
- Collapse or expand all methods in Log Details while preserving search results, timeline navigation and saved folds.
- Redesign Execution Flow with nested call rows, operation type toggles, separate debug/issue lanes, and a timing inspector with source navigation.
- Add explicit scope focus and breadcrumbs, previous/next issue navigation, anchored zoom up to 16×, keyboard navigation, and adjustable panel height with persisted state.
- Create debug levels with configurable category verbosity and select existing levels from the toolbar button next to Set TraceFlag for User or the Command Palette.
- Remember the selected level per org and workspace, apply it to active trace flags managed by the extension, and use it for future trace flags.

### Fixed
- Keep log downloads and expired-session retries tied to the original Salesforce org.
- Renew trace flags within the 24-hour limit, recreate deleted flags, and report permanent renewal failures.
- Apply changes to log visibility, auto-refresh, and trace-flag expiration settings immediately.
- Align the documented VS Code requirement with version 1.100.0.
- Keep focused execution counters within source-line boundaries, preserve access to dense markers, and label missing end events and unavailable timings accurately.
- Calculate elapsed self time without double-counting overlapping children and render only visible timeline rows and time ranges.
- Preserve raw log text, multiline debug output, subsecond timestamps, and original source positions in Log Details.
- Keep search results correct inside folded methods and preserve filters when navigating from the execution timeline.
- Parse large logs in a worker with a chunked fallback, cache filtered rows, and group dense timeline markers.
- Align table headers and rows, add resizable columns, and fit the timeline to narrow or resized panels.
- Identify Flow errors, exceptions, fault paths, and fatal errors separately.
- Restore filters, folds, selection, columns, scroll positions, and timeline state when the webview is recreated.
- Send log content after the webview is ready and include regression tests for Log Details.

## [1.2.7]
### Fixed
- Switching orgs immediately clears old logs and retrieves the new org's logs without waiting for previous requests to finish.
- Discards outdated log responses and errors so they cannot overwrite the panel or interrupt the current refresh.
- Prevents late session-expiry recovery from replacing a newly selected org connection.
- Keeps trace-flag requests, user IDs, and debug-level IDs on the same Salesforce connection.
- Serializes overlapping org switches, avoids duplicate trace-flag setup, and prevents cancelled renewal timers from restarting.
- Preserves log visibility settings when trace-flag setup fails and preserves search filters during queued refreshes.
- Rejects trace-flag user selections made before an org switch and adds org/user context to trace-flag diagnostics.

## [1.2.6]
### Fixed
- Replaced slow Salesforce CLI authentication subprocesses with direct Salesforce Core auth loading.
- Added validated connection startup with bounded retries and working expired-session refresh.
- Made failed activation recoverable without reloading VS Code.

### Added
- Added a **Retry Salesforce Connection** command, panel action, and error notification action.
- Automatically retries when a target-org configuration file is created or changed.
- Improved the log panel layout for narrow and resized VS Code panels.

## [1.2.5]
### Changed
- Fix: Use `sf org auth show-access-token` to get the real access token (sf org display now redacts it)
- Improvement: Parallelize sf CLI commands for faster connection startup
- Improvement: Add timeout and maxBuffer to command execution

## [1.2.4]
### Changed
Fixed:
- Fix: Error handling and error screen to avoid extension crash
- Fix: Log rendering issues and corrupted file handling
- Fix: Row color display
- Improvement: Enhanced Apex Log Details UI

## [1.2.3]
### Changed
- Fix queryMore all users in the set flag options

## [1.2.2]
### Changed
- Fix Delete all logs button

## [1.2.1]
### Changed
- Logo update

## [1.2.0]
### Added
- Added Trace Flag Management functionality
- New Section for Log Details & USER_DEBUG Filtering 
- Virtual scrolling for log details panel
- New output configuration on start added
- Option to delete all expired trace flags from the connected org

### Changed
- Minor bugs
- Process optimization
- Retry when connection expires
- Updated feature list to reflect current extension capabilities


## [1.1.1] 

### Added
- New inline search functionality in webview panel for quick log filtering
- Cursor position tracking in USER_DEBUG view
- State preservation when toggling USER_DEBUG filter
- Improved trace flag management logic
- Enhanced log file content management without marking as modified

### Fixed
- Various UI/UX improvements and bug fixes

### Changed
- Refactored and optimized code for better maintainability
- Improved error handling and user feedback

## [1.0.9] 

### Added
- Yellow circle indicator for logs being downloaded
- Visual feedback improvements for log states
- Better state preservation during auto-refresh

### Fixed
- State preservation issues during auto-refresh
- Visual feedback inconsistencies
- Log download status indication

## [1.0.6] 

### Added
- Visual indicators for unread logs
- Cache management for downloaded logs
- GZIP compression support for large logs

### Improved
- Grid performance optimization
- Auto-refresh flickering eliminated
- Hover state persistence
- Output channel consolidation

### Fixed
- Performance issues with large log files
- Flickering during auto-refresh
- Hover state persistence issues

## [1.0.5]

### Added
- Button to clear downloaded local log files
- Improved grid layout and responsiveness

### Fixed
- Auto-scroll issue during auto-refresh
- Duplicate trace flag creation bug
- Scroll position maintenance during refresh

### Changed
- Extension default location moved to bottom panel
- Improved overall UI responsiveness

## [1.0.0]

### Initial Release
- Auto-refreshing log viewer implementation
- Log filtering and management functionality
- Column customization with sorting capability
- Performance optimizations for large logs
- Basic grid layout implementation
- Log download and caching system
- Trace flag management
- User-specific log filtering
- Column width persistence
- Basic error handling
- Initial UI/UX implementation
