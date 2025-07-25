# Change Log

All notable changes to the "Salesforce AG Log Viewer" extension will be documented in this file.

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