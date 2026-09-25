#import <Foundation/Foundation.h>
#import <CoreLocation/CoreLocation.h>

#include <cstdint>
#include <cstring>

// Node-API is ABI-stable; these declarations keep the native build offline.
struct napi_env__;
struct napi_value__;
struct napi_deferred__;
struct napi_callback_info__;
using napi_env = napi_env__*;
using napi_value = napi_value__*;
using napi_deferred = napi_deferred__*;
using napi_callback_info = napi_callback_info__*;
using napi_status = int32_t;
using napi_callback = napi_value (*)(napi_env, napi_callback_info);
extern "C" napi_status napi_create_function(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
extern "C" napi_status napi_set_named_property(napi_env, napi_value, const char*, napi_value);
extern "C" napi_status napi_create_promise(napi_env, napi_deferred*, napi_value*);
extern "C" napi_status napi_resolve_deferred(napi_env, napi_deferred, napi_value);
extern "C" napi_status napi_create_object(napi_env, napi_value*);
extern "C" napi_status napi_get_boolean(napi_env, bool, napi_value*);
extern "C" napi_status napi_create_double(napi_env, double, napi_value*);
extern "C" napi_status napi_create_string_utf8(napi_env, const char*, size_t, napi_value*);

@class LocationRequest;
static NSMutableSet<LocationRequest*>* activeRequests;

static void setBoolean(napi_env env, napi_value object, const char* key, bool value) {
    napi_value property = nullptr;
    napi_get_boolean(env, value, &property);
    napi_set_named_property(env, object, key, property);
}

static void setNumber(napi_env env, napi_value object, const char* key, double value) {
    napi_value property = nullptr;
    napi_create_double(env, value, &property);
    napi_set_named_property(env, object, key, property);
}

static void setString(napi_env env, napi_value object, const char* key, NSString* value) {
    napi_value property = nullptr;
    const char* utf8 = value.UTF8String;
    napi_create_string_utf8(env, utf8, strlen(utf8), &property);
    napi_set_named_property(env, object, key, property);
}

@interface LocationRequest : NSObject <CLLocationManagerDelegate>
@property(nonatomic, assign) napi_env env;
@property(nonatomic, assign) napi_deferred deferred;
@property(nonatomic, strong) CLLocationManager* manager;
@property(nonatomic, strong) NSTimer* timer;
@property(nonatomic, assign) BOOL requestedLocation;
@property(nonatomic, assign) BOOL requestedAuthorization;
- (void)start;
@end

@implementation LocationRequest
- (void)completeWithLocation:(CLLocation*)location error:(NSString*)error {
    if (!_deferred) return;
    [_timer invalidate];
    _manager.delegate = nil;
    napi_value response = nullptr;
    napi_create_object(_env, &response);
    setBoolean(_env, response, "ok", location != nil);
    if (location) {
        napi_value result = nullptr;
        napi_create_object(_env, &result);
        setNumber(_env, result, "latitude", location.coordinate.latitude);
        setNumber(_env, result, "longitude", location.coordinate.longitude);
        setNumber(_env, result, "accuracyMeters", location.horizontalAccuracy);
        NSISO8601DateFormatter* formatter = [[NSISO8601DateFormatter alloc] init];
        setString(_env, result, "timestamp", [formatter stringFromDate:location.timestamp]);
        napi_set_named_property(_env, response, "result", result);
    } else {
        setString(_env, response, "error", error ?: @"macOS did not provide a location");
    }
    napi_deferred deferred = _deferred;
    _deferred = nullptr;
    napi_resolve_deferred(_env, deferred, response);
    [activeRequests removeObject:self];
}

- (void)start {
    if (![CLLocationManager locationServicesEnabled]) {
        [self completeWithLocation:nil error:@"Location Services are turned off in System Settings"];
        return;
    }
    _manager = [[CLLocationManager alloc] init];
    _manager.desiredAccuracy = kCLLocationAccuracyHundredMeters;
    _manager.delegate = self;
    _timer = [NSTimer scheduledTimerWithTimeInterval:60 target:self selector:@selector(timedOut) userInfo:nil repeats:NO];
    [self locationManagerDidChangeAuthorization:_manager];
}

- (void)timedOut {
    NSString* message = _manager.authorizationStatus == kCLAuthorizationStatusNotDetermined
        ? @"macOS did not complete the location permission request. Bring Off Grid AI Desktop to the foreground and try again."
        : @"macOS did not provide a location within 60 seconds. Check that Wi-Fi is on, then try again.";
    [self completeWithLocation:nil error:message];
}

- (void)locationManagerDidChangeAuthorization:(CLLocationManager*)manager {
    switch (manager.authorizationStatus) {
        case kCLAuthorizationStatusAuthorizedAlways:
            if (!_requestedLocation) {
                _requestedLocation = YES;
                [manager requestLocation];
            }
            break;
        case kCLAuthorizationStatusDenied:
        case kCLAuthorizationStatusRestricted:
            [self completeWithLocation:nil error:@"Location access is not allowed. Open System Settings > Privacy & Security > Location Services and allow Off Grid AI Desktop."];
            break;
        case kCLAuthorizationStatusNotDetermined:
            if (!_requestedAuthorization) {
                _requestedAuthorization = YES;
                [manager requestWhenInUseAuthorization];
            }
            break;
    }
}

- (void)locationManager:(CLLocationManager*)manager didUpdateLocations:(NSArray<CLLocation*>*)locations {
    [self completeWithLocation:locations.lastObject error:nil];
}

- (void)locationManager:(CLLocationManager*)manager didFailWithError:(NSError*)error {
    [self completeWithLocation:nil error:error.localizedDescription];
}
@end

static napi_value currentLocation(napi_env env, napi_callback_info) {
    napi_deferred deferred = nullptr;
    napi_value promise = nullptr;
    if (napi_create_promise(env, &deferred, &promise) != 0) return nullptr;
    if (!activeRequests) activeRequests = [[NSMutableSet alloc] init];
    LocationRequest* request = [[LocationRequest alloc] init];
    request.env = env;
    request.deferred = deferred;
    [activeRequests addObject:request];
    [request start];
    return promise;
}

extern "C" __attribute__((visibility("default"))) napi_value
napi_register_module_v1(napi_env env, napi_value exports) {
    napi_value function = nullptr;
    napi_create_function(env, "currentLocation", 15, currentLocation, nullptr, &function);
    napi_set_named_property(env, exports, "currentLocation", function);
    return exports;
}
