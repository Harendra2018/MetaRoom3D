function configureLights(lightManager) {

    // Main disk light
    let mainLight = new RectLight();
    mainLight.setPosition(29.4, 77.1, 38.2);
    mainLight.setRotation(0, 0.19, 0);
    mainLight.setScale(4,1,4);
    mainLight.setColor(1.0, 0.7, 0.4);
    mainLight.setIntensity(30.0);
    lightManager.addLight(mainLight);

    // Second disk light
    let secondLight = new RectLight();
    secondLight.setPosition(-35, 38.1, -40.2);
    secondLight.setRotation(0, 0.19, 0);
    secondLight.setScale(4,1,4);
    secondLight.setColor(1.0, 0.7, 0.4);
    secondLight.setIntensity(12.0);
    lightManager.addLight(secondLight);

    // Third disk light
    let thirdLight = new RectLight();
    thirdLight.setPosition(-10, 38.1, 63.2);
    thirdLight.setRotation(0, 0.19, 0);
    thirdLight.setScale(4,1,4);
    thirdLight.setColor(1.0, 0.7, 0.4);
    thirdLight.setIntensity(30.0);
    lightManager.addLight(thirdLight);

    // Return references for GUI / debug controls
    return {
        mainLight,
        secondLight,
        thirdLight
    };
}
