precision highp float;
precision highp int;
precision highp sampler2D;

#include <pathtracing_uniforms_and_defines>

uniform sampler2D tTriangleTexture;
uniform sampler2D tAABBTexture;
uniform sampler2D tAlbedoTextures[8];
uniform float uRoughness;

// Enhanced lighting system with multiple light types
uniform int uLightCount;
uniform int uLightType[8];
uniform vec3 uLightPosition[8];
uniform vec3 uLightEmission[8];
uniform float uLightRadius[8];
uniform vec3 uLightDirection[8];
uniform float uLightConeAngle[8];
uniform float uLightPenumbraAngle[8];
uniform float uLightAngularSize[8];
uniform vec3 uLightNormal[8];
uniform vec3 uLightV0[8];
uniform vec3 uLightV1[8];
uniform vec3 uLightV2[8];
uniform vec3 uLightV3[8];

vec3 rayOrigin, rayDirection;
vec3 hitNormal, hitEmission, hitColor;
vec2 hitUV;
float hitObjectID = -INFINITY;
float hitOpacity;
float hitMetalness;
float hitRoughness;
int hitType = -100;
int hitAlbedoTextureID;

// Firefly reduction: clamp maximum contribution
const float MAX_CONTRIBUTION = 100.0;

struct Box { vec3 minCorner; vec3 maxCorner; vec3 emission; vec3 color; int type; };
Box box;

#include <pathtracing_random_functions>
#include <pathtracing_quad_intersect>

#define INV_TEXTURE_WIDTH 0.00048828125
#define DIFF 1
#define REFR 2
#define SPEC 3
#define EMIT 4
#define LIGHT_TYPE_POINT 0
#define LIGHT_TYPE_SPOT 1
#define LIGHT_TYPE_SPHERE 2
#define LIGHT_TYPE_DISK 3
#define LIGHT_TYPE_RECT 4
#define MAX_LIGHTS 8

// Helper function to sample sphere
vec3 SampleSphere(vec3 center, float radius)
{
    float z = 2.0 * rng() - 1.0;
    float phi = 2.0 * PI * rng();
    float r = sqrt(1.0 - z * z);
    return center + radius * vec3(r * cos(phi), r * sin(phi), z);
}

// Helper function to sample disk
vec3 SampleDisk(vec3 center, vec3 normal, float radius)
{
    float r = sqrt(rng()) * radius;
    float theta = 2.0 * PI * rng();
    vec3 tangent = abs(normal.y) < 0.999 ? cross(normal, vec3(0, 1, 0)) : cross(normal, vec3(1, 0, 0));
    tangent = normalize(tangent);
    vec3 bitangent = cross(normal, tangent);
    return center + r * cos(theta) * tangent + r * sin(theta) * bitangent;
}

// Helper function to sample rectangle
vec3 SampleRect(vec3 v0, vec3 v1, vec3 v2, vec3 v3)
{
    float u = rng();
    float v = rng();
    vec3 p0 = mix(v0, v1, u);
    vec3 p1 = mix(v3, v2, u);
    return mix(p0, p1, v);
}

// Light data structure
struct LightData {
    int type;
    vec3 position;
    vec3 emission;
    float radius;
    vec3 direction;
    float coneAngle;
    float penumbraAngle;
    float angularSize;
    vec3 normal;
    vec3 v0;
    vec3 v1;
    vec3 v2;
    vec3 v3;
};

LightData lights[MAX_LIGHTS];
int numActiveLights;

/**
 * Initialize all lights from uniforms
 */
void SetupLights()
{
    numActiveLights = min(uLightCount, MAX_LIGHTS);
    
    for (int i = 0; i < MAX_LIGHTS; i++)
    {
        if (i < numActiveLights)
        {
            lights[i].type = uLightType[i];
            lights[i].position = uLightPosition[i];
            lights[i].emission = uLightEmission[i];
            lights[i].radius = uLightRadius[i];
            lights[i].direction = uLightDirection[i];
            lights[i].coneAngle = uLightConeAngle[i];
            lights[i].penumbraAngle = uLightPenumbraAngle[i];
            lights[i].angularSize = uLightAngularSize[i];
            lights[i].normal = uLightNormal[i];
            lights[i].v0 = uLightV0[i];
            lights[i].v1 = uLightV1[i];
            lights[i].v2 = uLightV2[i];
            lights[i].v3 = uLightV3[i];
        }
        else
        {
            lights[i].type = -1;
        }
    }
}

/**
 * Sample a random point on a random light
 */
vec3 SampleLight(out int lightIndex, out vec3 lightNormal, out float lightSelectProb)
{
    if (numActiveLights == 0) {
        lightIndex = -1;
        lightSelectProb = 1.0;
        return vec3(0);
    }
    
    // Pick a light proportionally to its power (emission luminance * area) instead of uniformly.
    // The estimate is still unbiased because the caller divides by lightSelectProb.
    float lightWeights[MAX_LIGHTS];
    float totalWeight = 0.0;
    for (int i = 0; i < MAX_LIGHTS; i++)
    {
        float w = 0.0;
        if (i < numActiveLights)
        {
            LightData L = lights[i];
            float lum = dot(L.emission, vec3(0.2126, 0.7152, 0.0722));
            float area = 1.0;
            if (L.type == LIGHT_TYPE_RECT)
                area = length(cross(L.v1 - L.v0, L.v3 - L.v0));
            else if (L.type == LIGHT_TYPE_DISK)
                area = PI * L.radius * L.radius;
            else
                area = 4.0 * PI * L.radius * L.radius;
            w = max(lum * area, 1e-6);
        }
        lightWeights[i] = w;
        totalWeight += w;
    }

    float pick = rng() * totalWeight;
    lightIndex = numActiveLights - 1;
    float acc = 0.0;
    for (int i = 0; i < MAX_LIGHTS; i++)
    {
        if (i >= numActiveLights) break;
        acc += lightWeights[i];
        if (pick < acc) { lightIndex = i; break; }
    }
    lightSelectProb = lightWeights[lightIndex] / totalWeight;
    
    LightData light = lights[lightIndex];
    lightNormal = vec3(0, 1, 0);
    
    if (light.type == LIGHT_TYPE_POINT) {
        return SampleSphere(light.position, light.radius);
    }
    else if (light.type == LIGHT_TYPE_SPOT) {
        return SampleSphere(light.position, light.radius);
    }
    else if (light.type == LIGHT_TYPE_SPHERE) {
        return SampleSphere(light.position, light.radius);
    }
    else if (light.type == LIGHT_TYPE_DISK) {
        lightNormal = light.normal;
        return SampleDisk(light.position, light.normal, light.radius);
    }
    else if (light.type == LIGHT_TYPE_RECT) {
        lightNormal = light.normal;
        return SampleRect(light.v0, light.v1, light.v2, light.v3);
    }
    
    return light.position;
}

/**
 * Intersect ray with sphere
 */
float IntersectSphere(vec3 center, float radius, vec3 rayOrigin, vec3 rayDirection)
{
    vec3 oc = rayOrigin - center;
    float b = dot(oc, rayDirection);
    float c = dot(oc, oc) - radius * radius;
    float disc = b * b - c;
    
    if (disc > 0.0) {
        float t = -b - sqrt(disc);
        if (t > 0.0) return t;
        t = -b + sqrt(disc);
        if (t > 0.0) return t;
    }
    
    return INFINITY;
}

/**
 * Intersect ray with disk
 */
float IntersectDisk(vec3 center, vec3 normal, float radius, vec3 rayOrigin, vec3 rayDirection)
{
    float denom = dot(normal, rayDirection);
    if (denom <= 0.0) return INFINITY;
    
    float t = dot(center - rayOrigin, normal) / denom;
    if (t < 0.0) return INFINITY;
    
    vec3 hitPoint = rayOrigin + t * rayDirection;
    vec3 toHit = hitPoint - center;
    if (dot(toHit, toHit) > radius * radius) return INFINITY;
    
    return t;
}

/**
 * Intersect ray with all lights
 */
float IntersectLights(vec3 rayOrigin, vec3 rayDirection, out vec3 hitNormal, out vec3 hitEmission, out int hitLightIndex)
{
    float minDist = INFINITY;
    hitLightIndex = -1;
    
    for (int i = 0; i < MAX_LIGHTS; i++)
    {
        if (i >= numActiveLights) break;
        
        LightData light = lights[i];
        float d = INFINITY;
        
        if (light.type == LIGHT_TYPE_POINT) {
            d = IntersectSphere(light.position, light.radius, rayOrigin, rayDirection);
            if (d < minDist) {
                minDist = d;
                hitNormal = normalize(rayOrigin + d * rayDirection - light.position);
                hitEmission = light.emission;
                hitLightIndex = i;
            }
        }
        else if (light.type == LIGHT_TYPE_SPOT) {
            d = IntersectSphere(light.position, light.radius, rayOrigin, rayDirection);
            if (d < minDist) {
                vec3 hitPoint = rayOrigin + d * rayDirection;
                vec3 toHit = normalize(hitPoint - light.position);
                float cosAngle = dot(toHit, light.direction);
                
                if (cosAngle > cos(light.coneAngle)) {
                    minDist = d;
                    hitNormal = normalize(hitPoint - light.position);
                    
                    float falloff = 1.0;
                    if (cosAngle < cos(light.penumbraAngle)) {
                        falloff = smoothstep(cos(light.coneAngle), cos(light.penumbraAngle), cosAngle);
                    }
                    
                    hitEmission = light.emission * falloff;
                    hitLightIndex = i;
                }
            }
        }
        else if (light.type == LIGHT_TYPE_SPHERE) {
            d = IntersectSphere(light.position, light.radius, rayOrigin, rayDirection);
            if (d < minDist) {
                minDist = d;
                hitNormal = normalize(rayOrigin + d * rayDirection - light.position);
                hitEmission = light.emission;
                hitLightIndex = i;
            }
        }
        else if (light.type == LIGHT_TYPE_DISK) {
            d = IntersectDisk(light.position, light.normal, light.radius, rayOrigin, rayDirection);
            if (d < minDist) {
                minDist = d;
                hitNormal = light.normal;
                hitEmission = light.emission;
                hitLightIndex = i;
            }
        }
        else if (light.type == LIGHT_TYPE_RECT) {
            d = QuadIntersect(light.v0, light.v1, light.v2, light.v3, rayOrigin, rayDirection, FALSE);
            if (d < minDist) {
                minDist = d;
                hitNormal = light.normal;
                hitEmission = light.emission;
                hitLightIndex = i;
            }
        }
    }
    
    return minDist;
}

#include <pathtracing_calc_fresnel_reflectance>
#include <pathtracing_sphere_intersect>
#include <pathtracing_box_intersect>
#include <pathtracing_boundingbox_intersect>
#include <pathtracing_bvhTriangle_intersect>

vec2 stackLevels[28];

void GetBoxNodeData(const in float i, inout vec4 boxNodeData0, inout vec4 boxNodeData1)
{
	float ix2 = i * 2.0;
	ivec2 uv0 = ivec2( mod(ix2 + 0.0, 2048.0), (ix2 + 0.0) * INV_TEXTURE_WIDTH );
	ivec2 uv1 = ivec2( mod(ix2 + 1.0, 2048.0), (ix2 + 1.0) * INV_TEXTURE_WIDTH );
	boxNodeData0 = texelFetch(tAABBTexture, uv0, 0);
	boxNodeData1 = texelFetch(tAABBTexture, uv1, 0);
}

float SceneIntersect(int sampleLight)
{
	vec4 currentBoxNodeData0, nodeAData0, nodeBData0, tmpNodeData0;
	vec4 currentBoxNodeData1, nodeAData1, nodeBData1, tmpNodeData1;
	vec4 vd0, vd1, vd2, vd3, vd4, vd5, vd6, vd7;
	vec3 inverseDir = 1.0 / rayDirection;
	vec3 normal, n;
	vec2 currentStackData, stackDataA, stackDataB, tmpStackData;
	ivec2 uv0, uv1, uv2, uv3, uv4, uv5, uv6, uv7;

	float d;
	float t = INFINITY;
	float stackptr = 0.0;
	float id = 0.0;
	float tu, tv;
	float triangleID = 0.0;
	float triangleU = 0.0;
	float triangleV = 0.0;
	float triangleW = 0.0;

	int objectCount = 0;
	hitObjectID = -INFINITY;
	int skip = FALSE;
	int triangleLookupNeeded = FALSE;
	int isRayExiting = FALSE;

	// BVH Traversal
	GetBoxNodeData(stackptr, currentBoxNodeData0, currentBoxNodeData1);
	currentStackData = vec2(stackptr, BoundingBoxIntersect(currentBoxNodeData0.yzw, currentBoxNodeData1.yzw, rayOrigin, inverseDir));
	stackLevels[0] = currentStackData;
	skip = (currentStackData.y < t) ? TRUE : FALSE;

	while (true)
	{
		if (skip == FALSE) 
		{
			if (--stackptr < 0.0)
				break;
			currentStackData = stackLevels[int(stackptr)];
			if (currentStackData.y >= t)
				continue;
			GetBoxNodeData(currentStackData.x, currentBoxNodeData0, currentBoxNodeData1);
		}
		skip = FALSE;
		
		if (currentBoxNodeData0.x < 0.0)
		{
			GetBoxNodeData(currentStackData.x + 1.0, nodeAData0, nodeAData1);
			GetBoxNodeData(currentBoxNodeData1.x, nodeBData0, nodeBData1);
			stackDataA = vec2(currentStackData.x + 1.0, BoundingBoxIntersect(nodeAData0.yzw, nodeAData1.yzw, rayOrigin, inverseDir));
			stackDataB = vec2(currentBoxNodeData1.x, BoundingBoxIntersect(nodeBData0.yzw, nodeBData1.yzw, rayOrigin, inverseDir));
			
			if (stackDataB.y < stackDataA.y)
			{
				tmpStackData = stackDataB;
				stackDataB = stackDataA;
				stackDataA = tmpStackData;
				tmpNodeData0 = nodeBData0; tmpNodeData1 = nodeBData1;
				nodeBData0 = nodeAData0; nodeBData1 = nodeAData1;
				nodeAData0 = tmpNodeData0; nodeAData1 = tmpNodeData1;
			}

			if (stackDataB.y < t)
			{
				currentStackData = stackDataB;
				currentBoxNodeData0 = nodeBData0;
				currentBoxNodeData1 = nodeBData1;
				skip = TRUE;
			}
			if (stackDataA.y < t)
			{
				if (skip == TRUE)
					stackLevels[int(stackptr++)] = stackDataB;
				currentStackData = stackDataA;
				currentBoxNodeData0 = nodeAData0; 
				currentBoxNodeData1 = nodeAData1;
				skip = TRUE;
			}
			continue;
		}

		// Leaf node - triangle intersection
		id = 9.0 * currentBoxNodeData0.x;
		uv0 = ivec2( mod(id + 0.0, 2048.0), (id + 0.0) * INV_TEXTURE_WIDTH );
		uv1 = ivec2( mod(id + 1.0, 2048.0), (id + 1.0) * INV_TEXTURE_WIDTH );
		uv2 = ivec2( mod(id + 2.0, 2048.0), (id + 2.0) * INV_TEXTURE_WIDTH );
		
		vd0 = texelFetch(tTriangleTexture, uv0, 0);
		vd1 = texelFetch(tTriangleTexture, uv1, 0);
		vd2 = texelFetch(tTriangleTexture, uv2, 0);

		d = BVH_TriangleIntersect( vec3(vd0.xyz), vec3(vd0.w, vd1.xy), vec3(vd1.zw, vd2.x), rayOrigin, rayDirection, tu, tv );

		if (d < t)
		{
			t = d;
			triangleID = id;
			triangleU = tu;
			triangleV = tv;
			triangleLookupNeeded = TRUE;
		}
	}

	// Full triangle data lookup
	if (triangleLookupNeeded == TRUE)
	{
		uv0 = ivec2( mod(triangleID + 0.0, 2048.0), floor((triangleID + 0.0) * INV_TEXTURE_WIDTH) );
		uv1 = ivec2( mod(triangleID + 1.0, 2048.0), floor((triangleID + 1.0) * INV_TEXTURE_WIDTH) );
		uv2 = ivec2( mod(triangleID + 2.0, 2048.0), floor((triangleID + 2.0) * INV_TEXTURE_WIDTH) );
		uv3 = ivec2( mod(triangleID + 3.0, 2048.0), floor((triangleID + 3.0) * INV_TEXTURE_WIDTH) );
		uv4 = ivec2( mod(triangleID + 4.0, 2048.0), floor((triangleID + 4.0) * INV_TEXTURE_WIDTH) );
		uv5 = ivec2( mod(triangleID + 5.0, 2048.0), floor((triangleID + 5.0) * INV_TEXTURE_WIDTH) );
		uv6 = ivec2( mod(triangleID + 6.0, 2048.0), floor((triangleID + 6.0) * INV_TEXTURE_WIDTH) );
		uv7 = ivec2( mod(triangleID + 7.0, 2048.0), floor((triangleID + 7.0) * INV_TEXTURE_WIDTH) );
		
		ivec2 uv8;
		vec4 vd8;
		uv8 = ivec2( mod(triangleID + 8.0, 2048.0), floor((triangleID + 8.0) * INV_TEXTURE_WIDTH) );
		
		vd0 = texelFetch(tTriangleTexture, uv0, 0);
		vd1 = texelFetch(tTriangleTexture, uv1, 0);
		vd2 = texelFetch(tTriangleTexture, uv2, 0);
		vd3 = texelFetch(tTriangleTexture, uv3, 0);
		vd4 = texelFetch(tTriangleTexture, uv4, 0);
		vd5 = texelFetch(tTriangleTexture, uv5, 0);
		vd6 = texelFetch(tTriangleTexture, uv6, 0);
		vd7 = texelFetch(tTriangleTexture, uv7, 0);
		vd8 = texelFetch(tTriangleTexture, uv8, 0);
		
		triangleW = 1.0 - triangleU - triangleV;
		hitNormal = normalize(triangleW * vec3(vd2.yzw) + triangleU * vec3(vd3.xyz) + triangleV * vec3(vd3.w, vd4.xy));
		hitColor = vd6.yzw;
		hitOpacity = vd7.y;
		hitUV = triangleW * vec2(vd4.zw) + triangleU * vec2(vd5.xy) + triangleV * vec2(vd5.zw);
		hitType = int(vd6.x);
		hitAlbedoTextureID = int(vd7.x);
		hitObjectID = float(objectCount);
		hitMetalness = vd7.z;
		hitRoughness = vd7.w;
		
		if (hitType == 4)
		{
			hitEmission = vd8.rgb * vd8.a;
		}
		else
		{
			hitEmission = vec3(0);
		}
	}
	objectCount++;

	// Ground plane intersection
	d = BoxIntersect( box.minCorner, box.maxCorner, rayOrigin, rayDirection, n, isRayExiting );
	if (d < t)
	{
		t = d;
		hitNormal = normalize(n);
		hitEmission = box.emission;
		hitColor = box.color;
		hitType = box.type;
		hitObjectID = float(objectCount);
		hitMetalness = 0.0;
		hitRoughness = 1.0;
		hitOpacity = 1.0;
		hitAlbedoTextureID = -1;
	}
	objectCount++;

	// Check intersection with lights (all types)
	if (sampleLight == FALSE)
	{
		vec3 lightHitNormal, lightHitEmission;
		int lightIdx;
		d = IntersectLights(rayOrigin, rayDirection, lightHitNormal, lightHitEmission, lightIdx);
		if (d < t && lightIdx >= 0)
		{
			t = d;
			hitNormal = lightHitNormal;
			hitEmission = lightHitEmission;
			hitColor = vec3(0);
			hitType = LIGHT_TYPE_RECT;
			hitObjectID = float(objectCount);
		}
	}
	objectCount++;
	
	return t;
}

vec3 CalculateRadiance( out vec3 objectNormal, out vec3 objectColor, out float objectID, out float pixelSharpness )
{
	vec3 accumCol = vec3(0.0);
	vec3 mask = vec3(1.0);
	vec3 reflectionMask = vec3(1.0);
	vec3 reflectionRayOrigin = vec3(0);
	vec3 reflectionRayDirection = vec3(0);
	vec3 n, nl, x;

	float t = INFINITY;
	float epsIntersect = 0.001;
	float lightHitDistance = INFINITY;
	float weight;
	float previousObjectID;

	int diffuseCount = 0;
	int previousIntersecType = -100;
	float previousOpacity = 1.0;
	hitType = -100;
	int bounceIsSpecular = TRUE;
	int sampleLight = FALSE;
	int ableToJoinPaths = FALSE;
	int willNeedReflectionRay = FALSE;
	int isReflectionTime = FALSE;

	// === LIGHT PATH TRACING (from Light source) ===
	// Sample from a random light (any type)
	int selectedLightIndex;
	vec3 lightNormal;
	float lightSelectionProbability;
	vec3 randPointOnLight = SampleLight(selectedLightIndex, lightNormal, lightSelectionProbability);
	vec3 lightHitEmission = lights[selectedLightIndex].emission;
	vec3 lightHitPos = randPointOnLight;
	
	// Account for selecting one light among many (probability adjustment)
	// Fixed: more robust light selection with emission scaling to reduce fireflies
	float emissionScale = min(lightHitEmission.r, max(lightHitEmission.g, lightHitEmission.b));
	lightHitEmission /= (lightSelectionProbability * (1.0 + emissionScale * 0.1));
	
	// Store original camera ray
	vec3 originalRayOrigin = rayOrigin;
	vec3 originalRayDirection = rayDirection;
	
	// Shoot ray from light
	rayDirection = randomCosWeightedDirectionInHemisphere(lightNormal);
	rayOrigin = randPointOnLight + lightNormal * epsIntersect;
	
	t = SceneIntersect(sampleLight);
	
	// If light ray hits diffuse surface, store the position
	if (hitType == DIFF && t < INFINITY)
	{
		lightHitPos = rayOrigin + rayDirection * t;
		weight = max(0.0, dot(-rayDirection, normalize(hitNormal)));
		lightHitEmission *= hitColor * weight;
	}
	
	// Reset to camera ray for eye path tracing
	rayOrigin = originalRayOrigin;
	rayDirection = originalRayDirection;
	hitType = -100;
	hitObjectID = -100.0;

	// === EYE PATH TRACING (from Camera) ===
	for (int bounces = 0; bounces < 10; bounces++)
	{
		// Firefly reduction: Russian Roulette to terminate low-contribution paths early
		float rrThreshold = 0.05;
		if (bounces > 2) {
			float contrib = max(max(mask.r, mask.g), mask.b);
			if (contrib < rrThreshold && rng() > contrib / rrThreshold) {
				break;
			}
			mask /= min(contrib / rrThreshold, 1.0);
		}

		previousIntersecType = hitType;
		previousObjectID = hitObjectID;

		t = SceneIntersect(sampleLight);

		if (t < INFINITY) {
			previousOpacity = hitOpacity;
		}

		// Hit light directly (any type)
		if (hitType == LIGHT_TYPE_RECT)
		{
			if (diffuseCount == 0 && isReflectionTime == FALSE)
				pixelSharpness = 1.0;

			if (isReflectionTime == TRUE && bounceIsSpecular == TRUE)
			{
				objectNormal += nl;
				objectID += hitObjectID;
			}
			
			if (bounceIsSpecular == TRUE || sampleLight == TRUE)
				accumCol += mask * hitEmission;

			// Firefly reduction: clamp contribution
			accumCol = min(accumCol, vec3(MAX_CONTRIBUTION));

			if (willNeedReflectionRay == TRUE)
			{
				mask = reflectionMask;
				rayOrigin = reflectionRayOrigin;
				rayDirection = reflectionRayDirection;

				willNeedReflectionRay = FALSE;
				bounceIsSpecular = TRUE;
				sampleLight = FALSE;
				isReflectionTime = TRUE;
				continue;
			}
			break;
		}

		// Hit emissive material directly
		if (hitType == 4)
		{
			if (diffuseCount == 0 && isReflectionTime == FALSE)
				pixelSharpness = 1.0;

			if (bounceIsSpecular == TRUE || sampleLight == TRUE)
				accumCol += mask * hitEmission;

			// Firefly reduction: clamp contribution
			accumCol = min(accumCol, vec3(MAX_CONTRIBUTION));

			if (willNeedReflectionRay == TRUE)
			{
				mask = reflectionMask;
				rayOrigin = reflectionRayOrigin;
				rayDirection = reflectionRayDirection;

				willNeedReflectionRay = FALSE;
				bounceIsSpecular = TRUE;
				sampleLight = FALSE;
				isReflectionTime = TRUE;
				continue;
			}
			break;
		}

		if (t == INFINITY)
		{
			break;
		}

		// Store useful data
		n = hitNormal;
		nl = dot(n, rayDirection) < 0.0 ? n : -n;
		x = rayOrigin + rayDirection * t;

		if (bounces == 0)
		{
			objectNormal = n;
			objectColor = hitColor;
			objectID = hitObjectID;
		}

		// === PATH CONNECTION: Check if we can join with light path ===
		if (hitType == DIFF && sampleLight == TRUE)
		{
			vec3 shadowTransmission = vec3(1.0);
			bool hitOpaqueSurface = false;
			
			// Firefly reduction: better visibility threshold scaled by distance
			float visibilityThreshold = 0.01 + t * 0.001;
			ableToJoinPaths = abs(t - lightHitDistance) < visibilityThreshold ? TRUE : FALSE;
			
			if (ableToJoinPaths == TRUE && !hitOpaqueSurface)
			{
				weight = max(0.0, dot(n, -rayDirection));
				accumCol += mask * lightHitEmission * weight * shadowTransmission;
				
				// Firefly reduction: clamp contribution
				accumCol = min(accumCol, vec3(MAX_CONTRIBUTION));
			}

			if (willNeedReflectionRay == TRUE)
			{
				mask = reflectionMask;
				rayOrigin = reflectionRayOrigin;
				rayDirection = reflectionRayDirection;

				willNeedReflectionRay = FALSE;
				bounceIsSpecular = TRUE;
				sampleLight = FALSE;
				isReflectionTime = TRUE;
				continue;
			}
			break;
		}

		// Shadow ray failed to find light (occluded)
		if (sampleLight == TRUE)
		{
			if (willNeedReflectionRay == TRUE)
			{
				mask = reflectionMask;
				rayOrigin = reflectionRayOrigin;
				rayDirection = reflectionRayDirection;

				willNeedReflectionRay = FALSE;
				bounceIsSpecular = TRUE;
				sampleLight = FALSE;
				isReflectionTime = TRUE;
				continue;
			}
			break;
		}

		// Store surface properties before branching
		vec3 surfaceColor = hitColor;
		float surfaceMetalness = hitMetalness;
		float surfaceRoughness = hitRoughness;
		float surfaceOpacity = hitOpacity;
		int surfaceType = hitType;
		
		// TEXTURE SAMPLING
		if (hitAlbedoTextureID >= 0 && hitAlbedoTextureID < 8) {
			if (hitAlbedoTextureID == 0) surfaceColor *= texture(tAlbedoTextures[0], hitUV).rgb;
			else if (hitAlbedoTextureID == 1) surfaceColor *= texture(tAlbedoTextures[1], hitUV).rgb;
			else if (hitAlbedoTextureID == 2) surfaceColor *= texture(tAlbedoTextures[2], hitUV).rgb;
			else if (hitAlbedoTextureID == 3) surfaceColor *= texture(tAlbedoTextures[3], hitUV).rgb;
			else if (hitAlbedoTextureID == 4) surfaceColor *= texture(tAlbedoTextures[4], hitUV).rgb;
			else if (hitAlbedoTextureID == 5) surfaceColor *= texture(tAlbedoTextures[5], hitUV).rgb;
			else if (hitAlbedoTextureID == 6) surfaceColor *= texture(tAlbedoTextures[6], hitUV).rgb;
			else if (hitAlbedoTextureID == 7) surfaceColor *= texture(tAlbedoTextures[7], hitUV).rgb;
		}
		
		if (surfaceOpacity < 0.99 && length(surfaceColor) < 0.1) {
			surfaceColor = max(surfaceColor, vec3(0.9));
		}

		// === GLASS/TRANSPARENT MATERIAL ===
		if (surfaceOpacity < 0.99)
		{
			bounceIsSpecular = TRUE;
			
			float ior = 1.5;
			float nc = 1.0;
			float nt = ior;
			
			vec3 glassN = nl;
			vec3 refractionNormal = n;
			bool entering = dot(n, -rayDirection) > 0.0;

			bool isThinGlass = false;
			float glassThickness = 0.0;
			if (entering) {
				vec3 testRayOrigin = x - refractionNormal * epsIntersect;
				vec3 testRayDirection = rayDirection;
				vec3 savedOrigin = rayOrigin;
				vec3 savedDirection = rayDirection;
				
				rayOrigin = testRayOrigin;
				rayDirection = testRayDirection;
				float testT = SceneIntersect(sampleLight);
				
				rayOrigin = savedOrigin;
				rayDirection = savedDirection;
				
				if (testT < 0.05) {
					isThinGlass = true;
					glassThickness = testT;
				}
			}

			float glassRoughness = clamp(surfaceRoughness + uRoughness, 0.0, 1.0);

			if (isThinGlass) {
				float cosThetaI = abs(dot(-rayDirection, glassN));
				float Rs = (nc - nt) / (nc + nt);
				float reflectance = Rs * Rs + (1.0 - Rs * Rs) * pow(1.0 - cosThetaI, 5.0);
				
				float effectiveReflectance = mix(0.0, reflectance, surfaceOpacity);
				
				if (rand() < effectiveReflectance) {
					vec3 reflectedDir = reflect(rayDirection, glassN);
					if (glassRoughness > 0.001) {
						reflectedDir = randomDirectionInSpecularLobe(reflectedDir, glassRoughness * glassRoughness);
					}
					rayDirection = normalize(reflectedDir);
					rayOrigin = x + glassN * epsIntersect;
					mask *= mix(vec3(1.0), surfaceColor, surfaceOpacity) * effectiveReflectance / max(effectiveReflectance, 0.001);
				} else {
					vec3 transmittedDir = rayDirection;
					if (glassRoughness > 0.001) {
						transmittedDir = randomDirectionInSpecularLobe(transmittedDir, glassRoughness * glassRoughness * 0.5);
					}
					rayDirection = normalize(transmittedDir);
					rayOrigin = x + rayDirection * (epsIntersect * 3.0);
					
					float absorptionDistance = glassThickness * 100.0;
					vec3 absorption = exp(-absorptionDistance * (1.0 - surfaceColor) * (surfaceOpacity * 2.0));
					mask *= absorption;
				}
			}
			else {
				if (!entering) {
					float tmp = nc;
					nc = nt;
					nt = tmp;
				}

				float eta = nc / nt;
				float cosThetaI = abs(dot(rayDirection, glassN));
				float sin2ThetaT = eta * eta * (1.0 - cosThetaI * cosThetaI);

				if (sin2ThetaT > 1.0) {
					vec3 reflectedDir = reflect(rayDirection, glassN);
					if (glassRoughness > 0.001) {
						reflectedDir = randomDirectionInSpecularLobe(reflectedDir, glassRoughness * glassRoughness);
					}
					rayDirection = normalize(reflectedDir);
					rayOrigin = x + glassN * epsIntersect;
					mask *= mix(vec3(1.0), surfaceColor, surfaceOpacity);
				}
				else {
					float cosThetaT = sqrt(1.0 - sin2ThetaT);
					float Rs = (nc * cosThetaI - nt * cosThetaT) / (nc * cosThetaI + nt * cosThetaT);
					float Rp = (nt * cosThetaI - nc * cosThetaT) / (nt * cosThetaI + nc * cosThetaT);
					float reflectance = (Rs * Rs + Rp * Rp) * 0.5;
					
					float P = 0.25 + 0.5 * mix(0.0, reflectance, surfaceOpacity);

					if (rand() < P) {
						vec3 reflectedDir = reflect(rayDirection, glassN);
						if (glassRoughness > 0.001) {
							reflectedDir = randomDirectionInSpecularLobe(reflectedDir, glassRoughness * glassRoughness);
						}
						rayDirection = normalize(reflectedDir);
						rayOrigin = x + glassN * epsIntersect;
						mask *= mix(vec3(1.0), surfaceColor, surfaceOpacity) * (reflectance / max(P, 0.001));
					}
					else {
						vec3 refracted = refract(rayDirection, refractionNormal, eta);
						if (glassRoughness > 0.001) {
							refracted = randomDirectionInSpecularLobe(refracted, glassRoughness * glassRoughness);
						}
						rayDirection = normalize(refracted);
						rayOrigin = x - refractionNormal * epsIntersect;
						
						vec3 colorFilter = mix(vec3(1.0), surfaceColor, surfaceOpacity);
						mask *= colorFilter * ((1.0 - reflectance) / max((1.0 - P), 0.001));
					}
				}
			}
			continue;
		}

		// === PRINCIPLED BSDF (Opaque materials) ===
		vec3 N = nl;
		vec3 V = -rayDirection;
		vec3 X = x;

		float rough = clamp(surfaceRoughness + uRoughness, 0.04, 1.0);
		vec3 F0 = mix(vec3(0.04), surfaceColor, surfaceMetalness);

		float VoN = max(dot(V, N), 0.0);
		vec3 F = F0 + (1.0 - F0) * pow(1.0 - VoN, 5.0);

		vec3 kS = F;
		vec3 kD = (1.0 - kS) * (1.0 - surfaceMetalness);

		float specularProbability = clamp(max(max(F.r, F.g), F.b), 0.05, 0.95);

		if (rand() < specularProbability)
		{
			bounceIsSpecular = TRUE;
			vec3 R = reflect(-V, N);
			R = randomDirectionInSpecularLobe(R, rough * rough);
			rayDirection = normalize(R);
			rayOrigin = X + N * epsIntersect;
			mask *= kS / specularProbability;
		}
		else
		{
			bounceIsSpecular = FALSE;
			diffuseCount++;

			mask *= (kD * surfaceColor) / (1.0 - specularProbability);

			if (diffuseCount == 1 && hitObjectID != previousObjectID)
			{
				reflectionMask = mask;
				reflectionRayOrigin = X + N * epsIntersect;
				reflectionRayDirection = randomCosWeightedDirectionInHemisphere(N);
				willNeedReflectionRay = TRUE;
			}

			rayOrigin = X + N * epsIntersect;
			rayDirection = normalize(lightHitPos - X);
			weight = max(0.0, dot(N, rayDirection));
			mask *= weight;
			lightHitDistance = distance(rayOrigin, lightHitPos);
			sampleLight = TRUE;
		}
	}

	return max(vec3(0), accumCol);
}

void SetupScene(void)
{
	// Ground plane
	box = Box( vec3(-100000, -1, -100000), vec3(100000, 0, 100000), 
              vec3(0), vec3(0.45), DIFF);

	// Initialize all lights
	SetupLights();
}

#include <pathtracing_main>
